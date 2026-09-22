import { z } from 'zod';

export const idSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase words separated by hyphens',
  );
export const agents = ['codex', 'claude'] as const;
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p === '.' ||
      (!p.startsWith('/') &&
        !/[\\:\x00-\x1f*?\[\]!#]/.test(p) &&
        p
          .split('/')
          .every(
            (s) => s !== '..' && s !== '.' && s !== '' && !s.endsWith(' '),
          )),
    'Use a relative path without traversal, glob characters, or backslashes',
  );
export const scopeSchema = relativePath.refine(
  (p) =>
    !p
      .split('/')
      .some((s) =>
        [
          '.git',
          '.loadout',
          '.loadout-personal',
          '.agents',
          '.claude',
          '.codex',
        ].includes(s),
      ),
  'Scope must be a repository directory outside configuration directories',
);
const condition = z
  .object({ answer: idSchema, equals: z.union([z.boolean(), z.string()]) })
  .strict();
const question = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('boolean'),
      message: z.string().min(1),
      default: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('choice'),
      message: z.string().min(1),
      choices: z.array(z.string().min(1)).min(1),
      default: z.string().optional(),
    })
    .strict(),
]);
const output = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('instructions'),
      source: relativePath,
      scope: scopeSchema.default('.'),
      when: condition.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skill'),
      source: relativePath,
      when: condition.optional(),
    })
    .strict(),
]);
export const kitSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    description: z.string().min(1),
    ready: z.boolean().optional(),
    requires: z.array(idSchema).default([]),
    questions: z.record(idSchema, question).default({}),
    outputs: z.array(output).default([]),
  })
  .strict()
  .refine((kit) => kit.ready === false || kit.outputs.length > 0, {
    message: 'Ready kits need at least one output',
    path: ['outputs'],
  })
  .superRefine((kit, context) => {
    if (kit.ready === false) return;
    for (const [key, question] of Object.entries(kit.questions)) {
      if (
        question.default !== undefined &&
        !validAnswer(question, question.default)
      )
        context.addIssue({
          code: 'custom',
          message: `${key}: invalid default`,
        });
      if (
        question.type === 'choice' &&
        new Set(question.choices).size !== question.choices.length
      )
        context.addIssue({
          code: 'custom',
          message: `${key}: duplicate choices`,
        });
    }
    for (const output of kit.outputs) {
      if (output.when) {
        const question = kit.questions[output.when.answer];
        if (!question || !validAnswer(question, output.when.equals))
          context.addIssue({
            code: 'custom',
            message: `Invalid condition on ${output.when.answer}`,
          });
      }
      if (
        output.type === 'skill' &&
        !idSchema.safeParse(output.source.split('/').at(-1)).success
      )
        context.addIssue({
          code: 'custom',
          message: `Invalid skill directory: ${output.source}`,
        });
    }
  });
export const externalSourceSchema = z
  .object({
    repo: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,
        'Use owner/repository',
      ),
    ref: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
        'Use a Git branch, tag, or commit',
      )
      .default('HEAD'),
    integrity: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Use a SHA-256 kit content hash')
      .optional(),
    skills: z
      .array(
        relativePath.refine(
          (p) => p !== '.' && idSchema.safeParse(p.split('/').at(-1)).success,
          'Use a skill directory with a lowercase name',
        ),
      )
      .max(20)
      .default([]),
    skillNames: z.record(relativePath, idSchema).optional(),
    kit: z
      .object({ path: relativePath, manifest: kitSchema })
      .strict()
      .optional(),
    license: relativePath.default('LICENSE'),
  })
  .strict()
  .refine(
    (source) => !!source.integrity || /^[a-f0-9]{40}$/.test(source.ref),
    'Provide a kit content hash or a legacy full 40-character Git commit SHA',
  )
  .refine(
    (source) =>
      source.kit ? source.skills.length === 0 : source.skills.length > 0,
    'Choose skill directories or a complete kit, not both',
  )
  .refine(
    (source) =>
      Object.keys(source.skillNames ?? {}).every((skill) =>
        source.skills.includes(skill),
      ),
    'Skill name mappings must refer to selected skill paths',
  );
export const externalKitSchema = z
  .object({
    id: idSchema,
    description: z.string().min(1),
    source: externalSourceSchema,
  })
  .strict()
  .refine(
    (kit) => !kit.source.kit || kit.source.kit.manifest.id === kit.id,
    'Manifest ID must match the kit ID',
  );
export type ExternalSource = z.infer<typeof externalSourceSchema>;
export type ExternalKit = z.infer<typeof externalKitSchema>;
export const catalogUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Use an HTTPS manifest URL (HTTP is allowed on localhost)');
export const catalogManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    name: z.string().min(1),
    description: z.string().default(''),
    providers: z.array(
      z
        .object({
          id: z.string().min(1),
          description: z.string().default(''),
          prefix: z.string().default(''),
          kits: z.array(externalKitSchema),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    const providers = new Set<string>();
    const kits = new Set<string>();
    for (const provider of manifest.providers) {
      if (providers.has(provider.id))
        context.addIssue({
          code: 'custom',
          message: `Duplicate provider: ${provider.id}`,
        });
      providers.add(provider.id);
      for (const kit of provider.kits) {
        if (kits.has(kit.id))
          context.addIssue({
            code: 'custom',
            message: `Duplicate kit ID: ${kit.id}`,
          });
        kits.add(kit.id);
      }
    }
  });
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
export const catalogInfoSchema = z
  .object({
    id: idSchema,
    url: catalogUrlSchema,
    name: z.string(),
    provider: z.string(),
    description: z.string(),
    prefix: z.string(),
  })
  .strict();
export type CatalogInfo = z.infer<typeof catalogInfoSchema>;
export type Subscription = { url: string; scopes: string[] };
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    curated: z.boolean().optional(),
    externalKits: z.array(externalKitSchema).default([]),
    catalogs: z.array(catalogUrlSchema).default([]),
  })
  .strict();
export const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    selected: z.array(idSchema),
    answers: z.record(
      idSchema,
      z.record(idSchema, z.union([z.boolean(), z.string()])),
    ),
  })
  .strict();
export const generatedSchema = z
  .object({
    schemaVersion: z.literal(1),
    installedAt: z.record(idSchema, z.iso.datetime()),
    files: z.record(
      z.string(),
      z
        .object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          mode: z.union([z.literal(420), z.literal(493)]),
        })
        .strict(),
    ),
  })
  .strict();
export type Question = z.infer<typeof question>;
export type Answer = boolean | string;
export type State = z.infer<typeof stateSchema>;
export type Generated = z.infer<typeof generatedSchema>;
export type Kit = z.infer<typeof kitSchema> & {
  directory: string;
  external?: ExternalSource;
  pinned?: ExternalSource;
  origin?: 'curated' | 'external' | 'bundled' | 'personal' | 'catalog';
  provider?: string;
  catalog?: CatalogInfo;
  subscriptions?: string[];
  unavailable?: boolean;
  problem?: string;
  offered?: ExternalSource;
  resources?: Record<string, { content: Buffer; mode: number }>;
};
export type Catalog = {
  root: string;
  kits: Map<string, Kit>;
  global?: boolean;
  subscriptions?: Subscription[];
};
export function validAnswer(q: Question, value: unknown): value is Answer {
  return q.type === 'boolean'
    ? typeof value === 'boolean'
    : typeof value === 'string' && q.choices.includes(value);
}
export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      `${label}: ${result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`,
    );
  return result.data;
}

export function kitSource(kit: Kit): string {
  if (kit.catalog) return kit.catalog.provider;
  return kit.origin === 'bundled'
    ? (kit.provider ?? 'loadout')
    : ((kit.pinned ?? kit.external)?.repo ??
        (kit.origin === 'personal' ? 'Personal' : 'Repository'));
}

export function sameSource(a: ExternalSource, b: ExternalSource): boolean {
  if (a.integrity || b.integrity)
    return (
      a.integrity === b.integrity &&
      stableJson(a.kit?.manifest) === stableJson(b.kit?.manifest)
    );
  return (
    a.repo === b.repo &&
    a.ref === b.ref &&
    a.license === b.license &&
    JSON.stringify(a.kit) === JSON.stringify(b.kit) &&
    JSON.stringify([...a.skills].sort()) ===
      JSON.stringify([...b.skills].sort()) &&
    a.skills.every((skill) => skillName(a, skill) === skillName(b, skill))
  );
}

export function skillName(source: ExternalSource, skill: string): string {
  return source.skillNames?.[skill] ?? skill.split('/').at(-1)!;
}

export function offeredSource(kit: Kit): ExternalSource | undefined {
  return kit.offered ?? kit.external;
}

export function sourceVersion(source: ExternalSource): string {
  return source.integrity ?? source.ref;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

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
      .regex(/^[a-f0-9]{40}$/, 'Use a full 40-character Git commit SHA'),
    skills: z
      .array(
        relativePath.refine(
          (p) => p !== '.' && idSchema.safeParse(p.split('/').at(-1)).success,
          'Use a skill directory with a lowercase name',
        ),
      )
      .min(1)
      .max(20),
    license: relativePath.default('LICENSE'),
  })
  .strict();
export const externalKitSchema = z
  .object({
    id: idSchema,
    description: z.string().min(1),
    source: externalSourceSchema,
  })
  .strict();
export type ExternalSource = z.infer<typeof externalSourceSchema>;
export type ExternalKit = z.infer<typeof externalKitSchema>;
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    curated: z.boolean().default(true),
    externalKits: z.array(externalKitSchema).default([]),
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
export const ownedSchema = z
  .object({
    schemaVersion: z.literal(1),
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
export type Kit = z.infer<typeof kitSchema> & {
  directory: string;
  external?: ExternalSource;
  pinned?: ExternalSource;
  origin?: 'curated' | 'external' | 'bundled' | 'personal';
};
export type Catalog = {
  root: string;
  kits: Map<string, Kit>;
  global?: boolean;
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
  return kit.origin === 'bundled'
    ? 'loadout'
    : ((kit.pinned ?? kit.external)?.repo ??
        (kit.origin === 'personal' ? 'Personal' : 'Repository'));
}

export function sameSource(a: ExternalSource, b: ExternalSource): boolean {
  return (
    a.repo === b.repo &&
    a.ref === b.ref &&
    a.license === b.license &&
    JSON.stringify([...a.skills].sort()) ===
      JSON.stringify([...b.skills].sort())
  );
}

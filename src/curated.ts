import { externalKitSchema, parse, type ExternalKit } from './schema.js';

export const providerDescriptions: Readonly<Record<string, string>> = {
  'mattpocock/skills':
    'Test-driven development, debugging, planning, and agent workflows',
  'anthropics/skills':
    'Interface design, browser testing, MCP servers, and generative art',
};

// Definitions ship with Loadout; upstream content is fetched only when selected.
const matt = {
  repo: 'mattpocock/skills',
  ref: '3cca18b368ae95cdbdebbff572ccafa662551015',
  license: 'LICENSE',
};
const engineering: [string, string, string[]?][] = [
  [
    'tdd',
    'Build features test-first with behavior checks that survive refactors',
    ['codebase-design'],
  ],
  [
    'diagnosing-bugs',
    'Reproduce a failure, isolate its cause, and verify the fix',
  ],
  [
    'domain-modeling',
    'Define shared project terms and capture architecture decisions',
  ],
  [
    'prototype',
    'Try an interface or state model before committing to a design',
  ],
  [
    'research',
    'Investigate a question and save findings with source citations',
  ],
  [
    'resolving-merge-conflicts',
    'Resolve conflicts, verify the result, and commit the merge',
  ],
  ['wizard', 'Create a step-by-step Bash wizard for setup only a human can do'],
];
const productivity: [string, string, string[]?][] = [
  [
    'grill-me',
    'Challenge a plan until its assumptions and trade-offs are clear',
    ['grilling'],
  ],
  [
    'writing-for-agents',
    'Write concise agent instructions with clear triggers and steps',
  ],
  [
    'handoff',
    'Save decisions, progress, and next steps for a fresh agent session',
  ],
  ['teach', 'Learn a topic through guided lessons, practice, and saved notes'],
  [
    'to-questionnaire',
    'Draft a questionnaire to get missing answers from someone else',
  ],
  ['wait-what', 'Re-explain the last answer with context and simpler language'],
];
const anthropic: [string, string][] = [
  [
    'frontend-design',
    'Build interfaces with a clear visual direction, layout, and typography',
  ],
  [
    'webapp-testing',
    'Check UI behavior and capture screenshots with Python + Playwright',
  ],
  ['mcp-builder', 'Build and evaluate MCP tools that connect agents to APIs'],
  [
    'algorithmic-art',
    'Create p5.js art with repeatable seeds and interactive controls',
  ],
];
export const curatedKits: ExternalKit[] = [
  ...(
    [
      ['engineering', engineering],
      ['productivity', productivity],
    ] as const
  ).flatMap(([group, kits]) =>
    kits.map(([name, description, supporting = []]) => ({
      id: `matt-pocock-${name}`,
      description,
      source: {
        ...matt,
        skills: [name, ...supporting].map(
          (skill) => `skills/${group}/${skill}`,
        ),
      },
    })),
  ),
  ...anthropic.map(([name, description]) => ({
    id: `anthropic-${name}`,
    description,
    source: {
      repo: 'anthropics/skills',
      ref: '34040c9c568585f6929bedeaad110ad08f079624',
      skills: [`skills/${name}`],
      license: `skills/${name}/LICENSE.txt`,
    },
  })),
].map((kit) => parse(externalKitSchema, kit, 'Curated kit'));

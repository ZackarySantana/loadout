import { externalKitSchema, parse, type ExternalKit } from './schema.js';

export const providerDescriptions: Readonly<Record<string, string>> = {
  'mattpocock/skills':
    'Test-driven development, debugging, planning, and agent workflows',
  'anthropics/skills':
    'Interface design, browser testing, MCP servers, art, and skill authoring',
  'vercel-labs/agent-skills':
    'React performance, component composition, and web interface reviews',
  'obra/superpowers':
    'Verification, code review, worktrees, and branch completion workflows',
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
  [
    'skill-creator',
    'Create, evaluate, and improve skills and their triggering descriptions',
  ],
];
const vercel: [string, string, string?][] = [
  [
    'react-best-practices',
    'Optimize React and Next.js rendering, data fetching, and bundle size',
    'vercel-react-best-practices',
  ],
  [
    'composition-patterns',
    'Design flexible React components with composition and shared state',
    'vercel-composition-patterns',
  ],
  [
    'web-design-guidelines',
    'Review web interfaces for accessibility, interaction, and UX issues',
  ],
];
const superpowers: [string, string][] = [
  [
    'verification-before-completion',
    'Run fresh checks and confirm evidence before claiming work is complete',
  ],
  [
    'receiving-code-review',
    'Evaluate review feedback and verify suggestions before implementing them',
  ],
  [
    'requesting-code-review',
    'Dispatch a focused reviewer to check changes against requirements',
  ],
  [
    'using-git-worktrees',
    'Set up an isolated workspace and verify its starting test baseline',
  ],
  [
    'finishing-a-development-branch',
    'Verify changes and choose how to merge, publish, or keep a branch',
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
  ...vercel.map(([name, description, skillName]) => ({
    id: `vercel-${name}`,
    description,
    source: {
      repo: 'vercel-labs/agent-skills',
      ref: '063bee94c3f4df8453406c830b0a7df0f2860278',
      skills: [`skills/${name}`],
      ...(skillName ? { skillNames: { [`skills/${name}`]: skillName } } : {}),
      // Upstream declares its MIT license in the README.
      license: 'README.md',
    },
  })),
  ...superpowers.map(([name, description]) => ({
    id: `superpowers-${name}`,
    description,
    source: {
      repo: 'obra/superpowers',
      ref: '5bf4e78011075bcfc0dc295f0724994cd123ee71',
      skills: [`skills/${name}`],
      license: 'LICENSE',
    },
  })),
].map((kit) => parse(externalKitSchema, kit, 'Curated kit'));

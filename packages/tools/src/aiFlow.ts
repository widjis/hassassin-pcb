/**
 * How a project works with the AI (docs/06-agent-plugins.md, A14): **AI Full** (the agent takes the project
 * through its stages, stopping after each one for the user's go-ahead) or **AI Assisted** (the user works,
 * the agent helps when asked). Kept in the project: `meta.aiFlow` (mode, current stage, whether the agent is
 * waiting for the user) and `meta.agentLimits` (the limits the user set for the agent's choices).
 */
import type { Doc } from '@hassassin/core';
import { SPEC_FIELDS, type Spec } from './gates.ts';

export type AiMode = 'full' | 'assisted';
export const AI_STAGES = ['requirements', 'schematic', 'components', 'layout', 'review'] as const;
export type AiStage = (typeof AI_STAGES)[number];

export const STAGE_TITLES: Record<AiStage, string> = {
  requirements: 'Requirements',
  schematic: 'Schematic',
  components: 'Components',
  layout: 'Layout',
  review: 'Review',
};

/** What each stage of AI Full covers (told to the agent). */
const STAGE_WORK: Record<AiStage, string> = {
  requirements: 'Complete the requirements with set_spec: ask the user about essentials that are missing (one short list of questions), propose values for the fields they left to you, and say which values are your proposals. Choose the main blocks and the key parts to use (research them with the web tools if they are on), but do not draw the schematic yet.',
  schematic: 'Draw the schematic block by block with real or generic parts, wire it, finish it (compact_blocks, tidy_wires, group boxes, sheet frame) and make run_erc clean. Do not place parts on the board yet.',
  components: 'Give every part a real footprint and a manufacturer part number within the project\'s limits (distributors, package sizes, budget), with price and stock where known; never invent part numbers. Then update_pcb so the board has every part.',
  layout: 'Set the board outline, place the parts, route the board and fill the pours, until run_drc has no errors and nothing is unrouted.',
  review: 'Review the whole design (decoupling, current capacity, thermal, ESD, manufacturability, the limits) and list the findings by severity, fixing what is clearly wrong after saying so.',
};

export interface AiFlow {
  mode: AiMode;
  stage: AiStage;
  /** The agent finished the stage and waits for the user's go-ahead. */
  waiting: boolean;
  /** The agent's summary of the finished stage, and what is still open. */
  summary?: string;
  open?: string;
  /** Every stage finished: the project went through review. */
  done?: boolean;
}

export type Autonomy = 'ask' | 'auto' | 'full';

/** Limits the user set for the agent's choices (A6, A13). */
export interface AgentLimits {
  distributors: string[];
  /** Smallest passive package the agent may use, e.g. "0402". */
  smallestPackage?: string;
  /** Budget per board (parts), free text with currency, e.g. "USD 8". */
  budget?: string;
  layers?: number;
  boardSize?: string;
  /** Packages the agent must not use (e.g. BGA, QFN). */
  avoid?: string[];
  autonomy: Autonomy;
}

export const DEFAULT_LIMITS: AgentLimits = { distributors: ['LCSC', 'Mouser'], smallestPackage: '0402', layers: 2, avoid: ['BGA'], autonomy: 'auto' };

export const AUTONOMY_LABEL: Record<Autonomy, string> = { ask: 'Ask every time', auto: 'Automatic within limits', full: 'Full' };

export function aiFlowOf(doc: Doc | null | undefined): AiFlow | null {
  const v = doc?.meta.aiFlow as Partial<AiFlow> | undefined;
  if (!v || (v.mode !== 'full' && v.mode !== 'assisted')) return null;
  const stage = AI_STAGES.includes(v.stage as AiStage) ? (v.stage as AiStage) : 'requirements';
  return { mode: v.mode, stage, waiting: !!v.waiting, ...(v.summary ? { summary: String(v.summary) } : {}), ...(v.open ? { open: String(v.open) } : {}), ...(v.done ? { done: true } : {}) };
}

export function limitsOf(doc: Doc | null | undefined): AgentLimits {
  const v = (doc?.meta.agentLimits ?? {}) as Partial<AgentLimits>;
  return {
    ...DEFAULT_LIMITS,
    ...v,
    distributors: Array.isArray(v.distributors) ? v.distributors.map(String) : DEFAULT_LIMITS.distributors,
    autonomy: v.autonomy === 'ask' || v.autonomy === 'full' ? v.autonomy : 'auto',
  };
}

export const nextStage = (s: AiStage): AiStage | null => AI_STAGES[AI_STAGES.indexOf(s) + 1] ?? null;

const limitText = (l: AgentLimits) =>
  [
    `distributors: ${l.distributors.length ? l.distributors.join(', ') : 'any'}`,
    l.smallestPackage ? `smallest passive package: ${l.smallestPackage}` : '',
    l.avoid?.length ? `avoid packages: ${l.avoid.join(', ')}` : '',
    l.budget ? `parts budget per board: ${l.budget}` : '',
    l.layers ? `copper layers: ${l.layers}` : '',
    l.boardSize ? `board size: ${l.boardSize}` : '',
    `choosing parts: ${l.autonomy === 'ask' ? 'ask the user to pick each part' : 'choose within these limits and list what you chose'}`,
  ]
    .filter(Boolean)
    .join('; ');

/**
 * The context the agent gets with each message of an AI Full project: the stage it is in, what that stage
 * covers, the limits, and that it stops at the end of the stage. Empty for AI Assisted.
 */
export function aiFlowNote(doc: Doc | null | undefined): string {
  const f = aiFlowOf(doc);
  if (!f || f.mode !== 'full') return '';
  const l = limitsOf(doc);
  const next = nextStage(f.stage);
  if (f.done) return `This project is in AI Full mode and has been through every stage. Help with what the user asks. Limits for your choices: ${limitText(l)}.`;
  return [
    `This project is in AI Full mode: you take it through its stages, one at a time, and stop after each for the user's go-ahead.`,
    `Current stage: ${STAGE_TITLES[f.stage]}. ${STAGE_WORK[f.stage]}`,
    `Limits for your choices: ${limitText(l)}.`,
    f.waiting
      ? `You finished this stage and the user has not continued yet: do what they ask in this message (changes within this stage), then call finish_stage again with an updated summary. Do not start ${next ? `the ${STAGE_TITLES[next]} stage` : 'anything else'}.`
      : `When the stage is done, mark your checklist done, call finish_stage with a short summary of what you did and what is open, then end your reply. Decisions only the user can make (a choice between options, a value to confirm) go to them with ask_user in the same reply, as buttons, not as prose in the summary. Never start ${next ? `the ${STAGE_TITLES[next]} stage` : 'anything beyond the review'} yourself: the user starts it.`,
  ].join('\n');
}

export interface WizardAnswers {
  description: string;
  spec: Partial<Spec>;
  limits: AgentLimits;
}

/** The first message of an AI Full project, built from the wizard. */
export function wizardPrompt(a: WizardAnswers): string {
  const given = SPEC_FIELDS.filter((f) => f.key !== 'goal' && (a.spec[f.key] ?? '').trim()).map((f) => `- ${f.label}: ${a.spec[f.key]!.trim()}`);
  const open = SPEC_FIELDS.filter((f) => f.key !== 'goal' && !(a.spec[f.key] ?? '').trim()).map((f) => f.label);
  return [
    `I want to build: ${a.description.trim()}`,
    given.length ? `Requirements I know:\n${given.join('\n')}` : 'I have not given other requirements.',
    open.length ? `Propose values for: ${open.join(', ')} (say they are your proposals).` : '',
    `Limits for your choices: ${limitText(a.limits)}.`,
    'Start with the Requirements stage.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A message that only says "go on" (English or Indonesian): while a stage waits it starts the next one. */
export function isGoAhead(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!…]+$/, '');
  return /^(lanjut(kan)?( aja| saja| ya)?|ya,? lanjut(kan)?|oke?,? lanjut(kan)?|gas|next|continue|go( on| ahead)?|ok(ay)?,? (continue|go on)|proceed|lanjut ke (tahap )?(berikut(nya)?|selanjutnya))$/.test(t);
}

/** A short project name from the wizard's description. */
export function projectNameFrom(description: string): string {
  const words = description.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return words.slice(0, 40) || 'New project';
}

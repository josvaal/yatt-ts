/**
 * i18n selector (D14): English is the default locale, Spanish is the option.
 * All user-facing copy (prompts, SCHEMA_DOC, tool descriptions, validation
 * envelopes and error messages) lives in the locale files; code elsewhere
 * only consumes `getStrings(locale)`.
 */
import { en } from './en.js';
import { es } from './es.js';

export type Locale = 'en' | 'es';

/** A registered MCP prompt: localized name, description and body. */
export interface PromptCopy {
  name: string;
  description: string;
  text: string;
}

/** Localized user-facing messages used by tools and resources. */
export interface YattMessages {
  testDoesNotExist: (name: string) => string;
  testAlreadyExists: (name: string) => string;
  testMissingCreate: (name: string) => string;
  testNameTaken: (name: string) => string;
  reportMissingGet: (name: string) => string;
  reportMissingDelete: (name: string) => string;
  baselineMissing: (name: string) => string;
  subFlowMissing: (name: string) => string;
  datasetSummary: (rows: number, columns: number) => string;
  /** Default name suffix for test_duplicate ("<name> (copy)"). */
  duplicateSuffix: string;
  dbReadOnly: () => string;
  /** Stacked SQL statements in one db_query call (F1: connection-mode parity). */
  dbMultipleStatements: string;
  dbEngineRequired: string;
  dbQueryTimeout: (timeoutMs: number) => string;
  /** Per-call `db` override while the appDb mode is `provider` (C47). */
  dbOverrideProviderOnly: string;
  /** test_run of a test with db steps while the appDb mode is `provider` (C46). */
  dbAssertNeedsConnection: (name: string) => string;
  /** Saved-test mirror missing at run time (runner). */
  runTestMissing: (name: string) => string;
  /** The CLI died without writing the outcome JSON (runner). */
  runFailedNoReport: (stderrTail: string) => string;
  /** Browser/db tools when `engine.enabled: false` (T9). */
  engineRequired: string;
  /** `browser_run_step` called without a step object carrying `action`. */
  stepMustHaveAction: string;
}

/** Localized descriptions for tool input arguments. */
export interface YattArgCopy {
  testName: string;
  nameToUpdate: string;
  newName: string;
  content: string;
  overwrite: string;
  suggestedName: string;
  format: string;
  write: string;
  reportName: string;
  sql: string;
  db: string;
  /** Runner arguments (test_run / test_run_dataset). */
  runName: string;
  env: string;
  overrides: string;
  stepTimeoutMs: string;
  browser: string;
  url: string;
  saveReport: string;
  rows: string;
  /** Browser tools (T9). */
  openUrl: string;
  headless: string;
  viewport: string;
  session: string;
  expression: string;
  runStepTimeoutMs: string;
  vars: string;
  conditionSelector: string;
  conditionValue: string;
  conditionTimeoutMs: string;
  intervalMs: string;
  scrollDy: string;
  clickX: string;
  clickY: string;
  tabIndex: string;
  tabUrl: string;
  sessionName: string;
}

/** Localized tool descriptions. */
export interface YattToolCopy {
  ping: string;
  schema: string;
  baselineList: string;
  baselineGet: string;
  testList: string;
  testGet: string;
  testCreate: string;
  testUpdate: string;
  testDelete: string;
  testRename: string;
  testDuplicate: string;
  testValidate: string;
  testExport: string;
  reportList: string;
  reportGet: string;
  reportDelete: string;
  dbQuery: string;
  testRun: string;
  testRunDataset: string;
  /** Browser tools (T9). */
  browserOpen: string;
  browserClose: string;
  browserStatus: string;
  browserPreview: string;
  browserEval: string;
  browserRunStep: string;
  browserCondition: string;
  browserScroll: string;
  browserClickAt: string;
  tabOpen: string;
  tabList: string;
  tabSwitch: string;
  tabClose: string;
  sessionSave: string;
  sessionList: string;
  sessionDelete: string;
}

/** Complete copy for one locale. */
export interface YattStrings {
  locale: Locale;
  /** Authoring manual for the YATT test format (schemaVersion 1). */
  schemaDoc: string;
  /** The 5 work prompts (localized names included). */
  prompts: PromptCopy[];
  resources: {
    schema: string;
    test: string;
    report: string;
  };
  tools: YattToolCopy;
  args: YattArgCopy;
  messages: YattMessages;
}

/** Returns the full copy for a locale (`'en'` default, `'es'` option). */
export function getStrings(locale: Locale): YattStrings {
  return locale === 'es' ? es : en;
}

export { en, es };

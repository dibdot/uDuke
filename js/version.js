// uDuke - the project stage: one number for the whole tree, shown in the
// debug line (Alt+D), so a screenshot can be traced back to a build. Every
// module carries it too (MODULE_STAGE), and boot refuses a mix of stages — a
// stale browser cache.
export const STAGE = 'stage12.194';
// version.js is a module too, and vouches for itself.
export const MODULE_STAGE = STAGE;

/** The archive-name form: stageNN.mm -> stageNN_mm. */
export const STAGE_FILE = STAGE.replace('.', '_');

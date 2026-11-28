// The packaged self-test's crash phase (DESIGN.md §4 PR11, R22, R23). Main forks ONE utility process
// with this argument (`pdfx --ocr-selftest` only: SupervisorDeps.forkArgs); that child crashes itself
// natively with process.crash() a moment after it starts, the way an engine crash would take it down,
// so the supervisor's real detection (an 'exit', a child-process-gone, or on Linux a hang caught by
// the liveness check) and its real respawn run on every OS. Only main picks a child's arguments:
// nothing a renderer sends can set this, and the normal app never passes it.

export const OCR_SELFTEST_CRASH_ARG = '--pdfx-ocr-selftest-crash'

/** After `ready`, so the crash hits a running child that has already handed over its port. */
export const OCR_SELFTEST_CRASH_DELAY_MS = 2_000

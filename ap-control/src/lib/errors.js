// Domain errors. RuleError signals a control-rule violation (§5) — the route layer
// renders these back to the user rather than treating them as a 500.

export class RuleError extends Error {
  /**
   * @param {string} rule  Rule id, e.g. 'R1', 'R2'
   * @param {string} message  Human-readable (Hebrew) explanation
   * @param {object} [meta]  Extra context for the view (e.g. conflicting invoice id)
   */
  constructor(rule, message, meta = {}) {
    super(message);
    this.name = 'RuleError';
    this.rule = rule;
    this.meta = meta;
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

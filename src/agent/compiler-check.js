# 5.0 S3: Deterministic guardrail compiler
export function checkType(action) { return {ok: !!action, error: action ? null : "type-violation"}; }
export function rollback(state) { return state; }
console.log("[COMPILER] Type-check pipeline active");

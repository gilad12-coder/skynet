export type ExecutionKind = "text" | "agent";
export type ExecutionMode = "auto" | ExecutionKind;

/** Infer only explicit task intent; candidate code and optimizer names are not evidence. */
export function inferExecutionKind(objective: string): ExecutionKind | null {
  const task = objective.trim().toLowerCase();
  if (!task) return null;
  // Negation, alternatives and explanations need a human choice instead of a keyword guess.
  if (
    /\b(not|never|without|don't|do not|versus|vs|or|about|explain|compare)\b|לא|בלי|ללא/.test(task)
  )
    return null;
  if (
    /^(?:please\s+)?(?:optimi[sz]e|improve|tune|refine|evolve)\s+(?:(?:the|my|these|our|a)\s+)?(?:instructions|system prompt|prompt)\s+(?:for|of|used by)\s+(?:(?:a|an|the|my|our)\s+)?(?:coding|software|programming)\s+agent\b/.test(
      task,
    ) ||
    /^(?:optimi[sz]e|improve|tune|refine)\s+(?:(?:my|the|our)\s+)?(?:coding|software|programming)\s+agent['’]s\s+(?:instructions|system prompt|prompt)\b/.test(
      task,
    ) ||
    /^(?:שפר|שפרי|שיפור)\s+(?:את\s+)?(?:הוראות|ההוראות|פרומפט|הפרומפט)\s+(?:של|עבור|ל)\s*(?:סוכן קוד|סוכן תכנות)/.test(
      task,
    )
  )
    return "agent";
  if (
    /^(?:please\s+)?(?:optimi[sz]e|improve|tune|refine|rewrite)\s+(?:(?:the|my|this|our|a)\s+)?(?:(?:python|javascript|typescript|sql)\s+)?(?:function|query|script|program|document|policy|configuration|config)\b/.test(
      task,
    ) ||
    /^(?:שפר|שפרי|שיפור)\s+(?:את\s+)?(?:הפונקציה|פונקציה|השאילתה|שאילתה|המסמך|מסמך|המדיניות|מדיניות)(?=\s|$)/.test(
      task,
    )
  )
    return "text";
  return null;
}

export function resolveExecutionKind(mode: ExecutionMode, objective: string): ExecutionKind {
  return mode === "auto" ? (inferExecutionKind(objective) ?? "text") : mode;
}

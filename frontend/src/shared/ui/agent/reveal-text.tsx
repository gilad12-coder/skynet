"use client";

import { motion, useReducedMotion } from "framer-motion";

const WORD_STAGGER_S = 0.035;
const MAX_REVEAL_DELAY_S = 1;

interface RevealTextProps {
  text: string;
  /** Write the line in; false for text that was already there (a reopened chat). */
  animate: boolean;
  className?: string;
}

/**
 * A line that writes itself in word by word, as streamed text does. Reduced
 * motion renders it at once.
 */
export function RevealText({ text, animate, className }: RevealTextProps) {
  const reduce = useReducedMotion();
  if (reduce || !animate) {
    return (
      <span dir="auto" className={className}>
        {text}
      </span>
    );
  }
  let word = 0;
  return (
    <span dir="auto" className={className}>
      {text.split(/(\s+)/).map((part, i) =>
        /^\s*$/.test(part) ? (
          part
        ) : (
          <motion.span
            key={i}
            initial={{ opacity: 0, filter: "blur(3px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            transition={{
              duration: 0.28,
              delay: Math.min(word++ * WORD_STAGGER_S, MAX_REVEAL_DELAY_S),
              ease: [0.2, 0.8, 0.2, 1],
            }}
          >
            {part}
          </motion.span>
        ),
      )}
    </span>
  );
}

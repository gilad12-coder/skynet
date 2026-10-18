// A narrow entry for the Check's terminal, so the submit flow does not load
// the trajectory viewer (and its stylesheets) to show one pop-up.
export { CheckTerminalSheet } from "./components/CheckTerminal";
export type {
  CheckTerminalPhaseState,
  CheckTerminalPhaseStatus,
} from "./components/CheckTerminal";
export { sampleProgress } from "./lib/check-terminal";

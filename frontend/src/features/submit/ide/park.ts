/**
 * Where the page's one VS Code workbench waits between pop-up opens.
 *
 * `visibility: hidden` is not enough: the editor's own layers set
 * `visibility` on themselves, so the last opened file stayed painted over the
 * wizard. `display: none` takes the whole subtree out of rendering and hit
 * testing; the pop-up re-lays the workbench out after it moves it back.
 */

/** The slice of an element parking touches, so it is testable without a DOM. */
export interface Parkable {
  readonly style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
}

/** The slice of a container parking appends to. */
export interface ParkHost<T> {
  append(...elements: T[]): void;
}

// Only what `park` sets; the workbench's own inline styles stay untouched.
const PARKED_STYLES: ReadonlyArray<readonly [string, string]> = [
  ["display", "none"],
  ["pointer-events", "none"],
];

/** Hide `element` completely and keep it in `body`, so it survives until the next open. */
export function park<T extends Parkable>(element: T, body: ParkHost<NoInfer<T>>): void {
  for (const [prop, value] of PARKED_STYLES) element.style.setProperty(prop, value);
  body.append(element);
}

/** Show `element` again inside `into`; the caller lays it out next. */
export function unpark<T extends Parkable>(element: T, into: ParkHost<NoInfer<T>>): void {
  for (const [prop] of PARKED_STYLES) element.style.removeProperty(prop);
  into.append(element);
}

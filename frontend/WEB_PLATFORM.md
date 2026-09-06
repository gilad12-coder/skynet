# Web platform scope

Skynet web is desktop-first. Optimization setup, code and workflow editing,
dataset editing, tagging, and detailed comparisons share one web implementation.
Do not build parallel phone-specific versions of those workflows.

Keep small-screen access available: no device-based route blocks, disabled
actions, or hidden settings. Authorization and run-state restrictions still apply.
Preserve usable sign-in, account/security/privacy controls, shared links, run
status, and basic navigation on phones.

Components own their layout. Use contained scrolling for wide tables and editors,
keep columns aligned, and avoid global media rules that rewrite every grid or
shrink every table. Retain keyboard access, readable text, touch targets, and
ordinary wrapping where it helps. Desktop-first also includes resizable desktop
windows and tablets; it does not mean a fixed-width page.

A future dedicated mobile app can focus on progress, notifications, agent chat,
approvals, and result review. It should share backend contracts and account state.
This web change does not introduce or advertise a mobile app.

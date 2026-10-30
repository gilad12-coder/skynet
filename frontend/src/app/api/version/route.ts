import { NextResponse } from "next/server";

// The commit this image was built from (baked in by the Dockerfile), so the
// uptime monitor can tell when the deployed frontend lags main.
export function GET() {
  return NextResponse.json({ commit: process.env.NEXT_PUBLIC_SOURCE_COMMIT || null });
}

import { NextResponse } from "next/server";

// The commit Railway built this image from (baked in by the Dockerfile), so the
// uptime monitor can tell when the deployed frontend lags main.
export function GET() {
  return NextResponse.json({ commit: process.env.NEXT_PUBLIC_SOURCE_COMMIT || null });
}

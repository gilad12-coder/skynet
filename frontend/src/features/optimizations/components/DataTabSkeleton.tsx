"use client";

import { hintedCount, useLayoutHint } from "@/shared/lib/layout-hint";
import { Card, CardContent } from "@/shared/ui/primitives/card";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/shared/ui/primitives/table";
import { ProgressBar } from "@/shared/ui/progress-bar";
import { Skeleton } from "@/shared/ui/skeleton";

/** The Data tab table as it last rendered: header columns, body rows, score column. */
export interface DataTabShape {
  columns: number;
  rows: number;
  score: boolean;
}

export function dataTabLayoutKey(optimizationId: string): string {
  return `data-tab:${optimizationId}`;
}

const CELL_WIDTHS = [55, 80, 70, 45, 65];

// Segmented and icon buttons are 44px tall below lg and under any coarse
// pointer (iPad, even with a trackpad), so the bones grow at the same points.
const SEGMENT_BONE = "block h-6 max-lg:h-[44px] any-pointer-coarse:h-[44px]";
const ICON_BONE = "block size-8 any-pointer-coarse:size-[44px]";

export function DataTabSkeleton({ optimizationId }: { optimizationId?: string }) {
  const hint = useLayoutHint<Partial<DataTabShape>>(
    optimizationId ? dataTabLayoutKey(optimizationId) : undefined,
  );
  const shape: DataTabShape = {
    columns: hintedCount(hint?.columns, 4, 40),
    // The table scrolls inside 520px, so rows past one screenful are never seen.
    rows: hintedCount(hint?.rows, 12, 16),
    score: hint?.score === true,
  };
  const { columns, rows } = shape;
  return (
    <div className="space-y-4 mt-4" aria-hidden="true">
      <div>
        <div className="flex h-5 items-center">
          <Skeleton height={14} containerClassName="block w-full lg:w-[85%]" />
        </div>
        <div className="flex h-5 items-center lg:hidden">
          <Skeleton height={14} containerClassName="block w-[45%]" />
        </div>
      </div>

      <div className="rounded-2xl border border-[#E5DDD4] bg-gradient-to-l from-[#FAF8F5] to-[#F5F1EC] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Skeleton width={140} height={14} />
          </div>
          <Skeleton
            height="100%"
            borderRadius={8}
            containerClassName="block h-9 w-[70px] shrink-0 max-lg:h-[48px] max-lg:w-[94px] any-pointer-coarse:h-[48px] any-pointer-coarse:w-[94px]"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="grid w-full grid-cols-4 gap-0.5 rounded-lg bg-muted p-0.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height="100%" containerClassName={SEGMENT_BONE} />
          ))}
        </div>
        <Skeleton width={64} height={10} containerClassName="me-auto" />
        <Skeleton height="100%" containerClassName={ICON_BONE} />
        <Skeleton height="100%" containerClassName={ICON_BONE} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="table-scroll max-h-[520px] overflow-hidden">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  {Array.from({ length: columns }).map((_, i) => (
                    <th
                      key={i}
                      className="ps-2 pe-4 py-3 text-center text-[0.75rem] font-semibold"
                      style={shape.score && i === 0 ? { width: 72 } : undefined}
                    >
                      {/* The sort button's box: 44px tall under a touch pointer. */}
                      <span className="inline-flex w-full items-center justify-center px-1.5 py-0.5 any-pointer-coarse:min-h-[44px]">
                        <Skeleton width="60%" height={10} inline />
                      </span>
                    </th>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: rows }).map((_, r) => (
                  <TableRow key={r}>
                    {Array.from({ length: columns }).map((_, i) =>
                      shape.score && i === 0 ? (
                        <TableCell key={i} className="!p-0 !px-1.5 !py-1" style={{ width: 72 }}>
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="text-[0.625rem] font-mono tabular-nums font-medium">
                              <Skeleton width={24} height={8} inline />
                            </span>
                            <ProgressBar value={0} max={1} />
                          </div>
                        </TableCell>
                      ) : (
                        <TableCell key={i} className="text-xs font-mono">
                          <Skeleton
                            width={`${CELL_WIDTHS[(r + i) % CELL_WIDTHS.length]}%`}
                            height={10}
                            inline
                          />
                        </TableCell>
                      ),
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

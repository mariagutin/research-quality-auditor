"use client";

// While a review is busy (uploading / processing / deleting), periodically re-run
// the server component so its DATABASE-time operation state (review_op_active) is
// re-fetched. That is how an ALREADY-OPEN page surfaces recovery controls after an
// interruption: once the operation goes stale (no heartbeat for the staleness
// window) or is confirmed-failed, the next refresh flips review_op_active to false,
// so Delete / Retry become enabled without the owner having to reload by hand.
//
// It also picks up a normal completion (e.g. a check finishing -> `complete`).

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function BusyRefresh({ intervalMs = 20_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}

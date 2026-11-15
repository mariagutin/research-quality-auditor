"use client";

// A small retry control for the review page. When review_op_active can't be loaded
// (finding #4), the page pauses mutating actions and shows this; clicking it re-runs
// the server component (which re-issues the RPC) without a full navigation.

import Button from "@mui/material/Button";
import { useRouter } from "next/navigation";

export default function RetryStatus() {
  const router = useRouter();
  return (
    <Button color="inherit" size="small" onClick={() => router.refresh()}>
      Retry
    </Button>
  );
}

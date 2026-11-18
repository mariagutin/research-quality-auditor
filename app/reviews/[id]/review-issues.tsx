"use client";

import { useState } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { DECISION_LABELS } from "@/lib/reviews/decisions";
import type { IssueEntry, IssuesView } from "@/lib/reviews/issues-view";
import type { DiffSeg } from "@/lib/reviews/text-compare";
import DecisionControl from "./decision-control";

const activeIssueTint = "#eaf3ff";

function Passage({ segments }: { segments: DiffSeg[] }) {
  return (
    <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {segments.map((segment, index) =>
        segment.changed ? (
          <Box component="mark" key={index} sx={{ bgcolor: "grey.200", color: "text.primary", fontWeight: 700, textDecoration: "underline" }}>
            {segment.text}
          </Box>
        ) : segment.text,
      )}
    </Typography>
  );
}

function IssueDetail({ entry }: { entry: IssueEntry }) {
  const { evidence, reportCredits } = entry;
  const sourceParticipant = evidence?.participantId;
  const showParticipants = entry.label.kind === "participant_mismatch" && reportCredits && sourceParticipant;

  return (
    <Stack spacing={1.5} sx={{ overflowWrap: "anywhere" }}>
      <Typography variant="h6" component="p" fontWeight={700} sx={{ display: { xs: "none", md: "block" } }}>
        &ldquo;{entry.quote}&rdquo;
      </Typography>
      {showParticipants && (
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1 }}>
          {[
            ["Credited in report", reportCredits],
            ["Found in transcript", sourceParticipant],
          ].map(([label, participant]) => (
            <Box key={label} sx={{ bgcolor: activeIssueTint, borderRadius: 2, p: 1 }}>
              <Typography variant="caption" color="text.secondary">{label}</Typography>
              <Typography variant="subtitle1" fontWeight={700}>{participant}</Typography>
            </Box>
          ))}
        </Box>
      )}
      {entry.note && !showParticipants && (
        <Typography variant="body2">{entry.note}</Typography>
      )}
      {evidence && (
        <Stack spacing={1.25} sx={{ bgcolor: activeIssueTint, borderLeft: "3px solid", borderColor: "#a3b6cd", borderRadius: 1, p: 1.25 }}>
          {evidence.kind === "diff" && (
            <Box>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                Report quote
              </Typography>
              <Passage segments={evidence.report} />
            </Box>
          )}
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              Transcript excerpt
              {evidence.filename && ` · ${evidence.filename}`}
              {evidence.participantId && ` · ${evidence.participantId}`}
            </Typography>
            {evidence.kind === "diff" ? (
              <Passage segments={evidence.transcript} />
            ) : (
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{evidence.excerpt}</Typography>
            )}
          </Box>
        </Stack>
      )}
      <DecisionControl issueId={entry.issueId} decision={entry.decision} />
    </Stack>
  );
}

export default function ReviewIssues({ view }: { view: IssuesView }) {
  const { entries, totalIssues, reviewedCount } = view;
  const [openIssueId, setOpenIssueId] = useState(
    () => (entries.find((entry) => !entry.decision) ?? entries[0])?.issueId ?? "",
  );

  return (
    <Stack spacing={1.25} component="section" aria-labelledby="review-issues-heading">
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={1}>
        <Typography variant="h6" component="h2" id="review-issues-heading" fontWeight={700}>
          Issues
        </Typography>
        <Typography variant="body2" color="text.secondary" role="status" sx={{ textAlign: "right" }}>
          {reviewedCount === totalIssues
            ? `All ${totalIssues} issue${totalIssues === 1 ? "" : "s"} reviewed. Your decisions are saved.`
            : (
              <>
                <Box component="strong" sx={{ color: "text.primary", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {reviewedCount} of {totalIssues}
                </Box>
                {` issue${totalIssues === 1 ? "" : "s"} reviewed`}
              </>
            )}
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={(reviewedCount / totalIssues) * 100}
        aria-label="Issues reviewed"
        aria-valuetext={`${reviewedCount} of ${totalIssues}`}
        sx={{ borderRadius: 2 }}
      />
      <Box
        sx={{
          display: { xs: "flex", md: "grid" },
          flexDirection: "column",
          gridTemplateColumns: { md: "minmax(260px, 34%) minmax(0, 1fr)" },
          gridTemplateRows: { md: `repeat(${entries.length}, max-content) 1fr` },
          alignItems: { md: "start" },
          gap: { xs: 1, md: "8px 20px" },
        }}
      >
        {entries.map((entry, index) => {
          const open = entry.issueId === openIssueId;
          const triggerId = `issue-trigger-${entry.issueId}`;
          const detailId = `issue-detail-${entry.issueId}`;
          const decision = entry.decision === "dismiss"
            ? "Dismissed"
            : entry.decision ? DECISION_LABELS[entry.decision] : "Unreviewed";
          const badgePalette = {
            dismiss: {
              bgcolor: open ? "#e4e7ec" : "#f0f2f5",
              color: "#4d5968",
              boxShadow: open ? "inset 0 0 0 1px #a3adba" : undefined,
            },
            needs_correction: { bgcolor: "#f8e9e9", color: "#802f34" },
            investigate: {
              bgcolor: open ? "#dce8f9" : "#e9eff9",
              color: "#294d80",
              boxShadow: open ? "inset 0 0 0 1px #819bc4" : undefined,
            },
            unreviewed: { bgcolor: "#fff0cf", color: "#704509" },
          }[entry.decision ?? "unreviewed"];

          return (
            <Box
              key={entry.issueId}
              sx={{
                display: { md: "contents" },
                border: { xs: "1px solid", md: 0 },
                borderColor: { xs: open ? "#dce8f7" : "divider" },
                borderRadius: 2,
                bgcolor: "background.paper",
              }}
            >
              <ButtonBase
                id={triggerId}
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setOpenIssueId(open ? "" : entry.issueId)}
                sx={{
                  width: "100%",
                  gridColumn: { md: 1 },
                  gridRow: { md: index + 1 },
                  p: 1.5,
                  gap: 1,
                  minHeight: 56,
                  justifyContent: "space-between",
                  textAlign: "left",
                  border: { md: "1px solid" },
                  borderColor: { md: open ? activeIssueTint : "divider" },
                  borderRadius: 2,
                  borderBottomLeftRadius: { xs: open ? 0 : 8, md: 8 },
                  borderBottomRightRadius: { xs: open ? 0 : 8, md: 8 },
                  bgcolor: open ? activeIssueTint : "background.paper",
                  "&:hover": { bgcolor: open ? activeIssueTint : "grey.50" },
                  "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 },
                }}
              >
                <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                  <Typography
                    component="span"
                    variant="body2"
                    fontWeight={700}
                    sx={{
                      display: { xs: open ? "block" : "-webkit-box", md: "-webkit-box" },
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                      overflowWrap: "anywhere",
                      fontSize: { xs: open ? "1.125rem" : undefined, md: undefined },
                    }}
                  >
                    &ldquo;{entry.quote}&rdquo;
                  </Typography>
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                    {entry.label.label}
                    {entry.issueCount > 1 && ` · Issue ${entry.issueIndex} of ${entry.issueCount} for this quotation`}
                  </Typography>
                </Box>
                <Typography
                  component="span"
                  variant="caption"
                  sx={{
                    ...badgePalette,
                    borderRadius: 10,
                    fontWeight: 700,
                    flexShrink: 0,
                    px: 1,
                    py: 0.35,
                    whiteSpace: "nowrap",
                  }}
                >
                  {decision}
                </Typography>
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{
                    width: 8,
                    height: 8,
                    mr: 0.5,
                    flexShrink: 0,
                    borderRight: "2px solid",
                    borderBottom: "2px solid",
                    borderColor: "text.secondary",
                    transform: { xs: open ? "rotate(225deg)" : "rotate(45deg)", md: "rotate(-45deg)" },
                  }}
                />
              </ButtonBase>
              <Box
                id={detailId}
                hidden={!open}
                role="region"
                aria-labelledby={triggerId}
                sx={{
                  display: open ? undefined : "none",
                  gridColumn: { md: 2 },
                  gridRow: { md: "1 / -1" },
                  minWidth: 0,
                  bgcolor: "background.paper",
                  border: { md: "1px solid #e9edf2" },
                  borderRadius: 2,
                  p: { xs: 1.5, md: 2.5 },
                }}
              >
                <IssueDetail entry={entry} />
              </Box>
            </Box>
          );
        })}
        {!openIssueId && (
          <Typography variant="body2" color="text.secondary" sx={{ display: { xs: "none", md: "block" }, gridColumn: 2, gridRow: 1, p: 2.5 }}>
            Select an issue to see its evidence and review decision.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

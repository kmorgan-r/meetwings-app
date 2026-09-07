import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Users, CheckCircle, ListTodo, Tag, Target, ArrowRight, MessageSquare,
} from "lucide-react";
import type { MeetingSummary, KnowledgeEntity } from "@/types";

export interface SummaryContentProps {
  summary: MeetingSummary;
  entities: KnowledgeEntity[];
  /** Default true. SummaryDetail.tsx passes false while isEditing, since it
   * renders its own Textarea for the summary text in that state and would
   * otherwise duplicate it directly below. */
  showSummary?: boolean;
}

export const SummaryContent = ({ summary, entities, showSummary = true }: SummaryContentProps) => {
  return (
    <div className="space-y-4">
      {showSummary && (
        <div className="space-y-2">
          <Label>Summary</Label>
          <p className="text-sm text-muted-foreground bg-accent/30 p-3 rounded-lg">
            {summary.summary}
          </p>
        </div>
      )}

      {summary.topics.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5" />
            Topics
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {summary.topics.map((topic, i) => (
              <Badge key={i} variant="secondary">{topic}</Badge>
            ))}
          </div>
        </div>
      )}

      {summary.participants.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            Participants
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {summary.participants.map((person, i) => (
              <Badge key={i} variant="outline">{person}</Badge>
            ))}
          </div>
        </div>
      )}

      {summary.goals && summary.goals.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Target className="h-3.5 w-3.5" />
            Goals
          </Label>
          <ul className="space-y-1">
            {summary.goals.map((goal, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {goal}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.actionItems.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <ListTodo className="h-3.5 w-3.5" />
            Action Items
          </Label>
          <ul className="space-y-1">
            {summary.actionItems.map((item, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.nextSteps && summary.nextSteps.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <ArrowRight className="h-3.5 w-3.5" />
            Next Steps
          </Label>
          <ul className="space-y-1">
            {summary.nextSteps.map((step, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.decisions.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <CheckCircle className="h-3.5 w-3.5" />
            Decisions
          </Label>
          <ul className="space-y-1">
            {summary.decisions.map((decision, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {decision}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.teamUpdates && summary.teamUpdates.length > 0 && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5" />
            Team Updates
          </Label>
          <ul className="space-y-1">
            {summary.teamUpdates.map((update, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground/50">-</span>
                {update}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entities.length > 0 && (
        <div className="space-y-2">
          <Label>Extracted Entities</Label>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((entity) => (
              <Badge key={entity.id} variant="outline" className="text-xs">
                <span className="capitalize text-muted-foreground mr-1">
                  {entity.entityType}:
                </span>
                {entity.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

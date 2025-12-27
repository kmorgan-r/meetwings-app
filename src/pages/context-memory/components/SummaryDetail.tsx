import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Save,
  X,
  Edit2,
  Users,
  CheckCircle,
  ListTodo,
  Loader2,
  Tag,
} from "lucide-react";
import { updateMeetingSummary, getEntitiesForSummary } from "@/lib/database";
import type { MeetingSummary, KnowledgeEntity } from "@/types";

interface SummaryDetailProps {
  summary: MeetingSummary | null;
  onClose: () => void;
  onUpdate: () => void;
}

export const SummaryDetail = ({
  summary,
  onClose,
  onUpdate,
}: SummaryDetailProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedSummary, setEditedSummary] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [entities, setEntities] = useState<KnowledgeEntity[]>([]);

  useEffect(() => {
    if (summary) {
      setEditedSummary(summary.summary);
      loadEntities(summary.id);
    }
  }, [summary]);

  const loadEntities = async (summaryId: string) => {
    try {
      const data = await getEntitiesForSummary(summaryId);
      setEntities(data);
    } catch (error) {
      console.error("Failed to load entities:", error);
    }
  };

  const handleSave = async () => {
    if (!summary) return;

    setIsSaving(true);
    try {
      await updateMeetingSummary(summary.id, {
        summary: editedSummary,
      });
      setIsEditing(false);
      onUpdate();
    } catch (error) {
      console.error("Failed to save summary:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedSummary(summary?.summary || "");
    setIsEditing(false);
  };

  if (!summary) {
    return (
      <Card className="shadow-none border border-border/70 rounded-xl">
        <CardContent className="py-12">
          <div className="flex flex-col items-center justify-center text-center">
            <Tag className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              Select a summary to view details
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <Card className="shadow-none border border-border/70 rounded-xl">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">Summary Details</CardTitle>
            <CardDescription>
              {formatDate(summary.createdAt)} at {formatTime(summary.createdAt)}
            </CardDescription>
          </div>
          <div className="flex gap-1">
            {isEditing ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  <X className="h-4 w-4" />
                </Button>
                <Button
                  variant="default"
                  size="icon"
                  className="h-8 w-8"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setIsEditing(true)}
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={onClose}
                >
                  <X className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="space-y-2">
          <Label>Summary</Label>
          {isEditing ? (
            <Textarea
              value={editedSummary}
              onChange={(e) => setEditedSummary(e.target.value)}
              rows={4}
              className="resize-none"
            />
          ) : (
            <p className="text-sm text-muted-foreground bg-accent/30 p-3 rounded-lg">
              {summary.summary}
            </p>
          )}
        </div>

        {/* Topics */}
        {summary.topics.length > 0 && (
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Tag className="h-3.5 w-3.5" />
              Topics
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {summary.topics.map((topic, i) => (
                <Badge key={i} variant="secondary">
                  {topic}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Participants */}
        {summary.participants.length > 0 && (
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5" />
              Participants
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {summary.participants.map((person, i) => (
                <Badge key={i} variant="outline">
                  {person}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Action Items */}
        {summary.actionItems.length > 0 && (
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <ListTodo className="h-3.5 w-3.5" />
              Action Items
            </Label>
            <ul className="space-y-1">
              {summary.actionItems.map((item, i) => (
                <li
                  key={i}
                  className="text-sm text-muted-foreground flex items-start gap-2"
                >
                  <span className="text-muted-foreground/50">-</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Decisions */}
        {summary.decisions.length > 0 && (
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <CheckCircle className="h-3.5 w-3.5" />
              Decisions
            </Label>
            <ul className="space-y-1">
              {summary.decisions.map((decision, i) => (
                <li
                  key={i}
                  className="text-sm text-muted-foreground flex items-start gap-2"
                >
                  <span className="text-muted-foreground/50">-</span>
                  {decision}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Extracted Entities */}
        {entities.length > 0 && (
          <div className="space-y-2">
            <Label>Extracted Entities</Label>
            <div className="flex flex-wrap gap-1.5">
              {entities.map((entity) => (
                <Badge
                  key={entity.id}
                  variant="outline"
                  className="text-xs"
                >
                  <span className="capitalize text-muted-foreground mr-1">
                    {entity.entityType}:
                  </span>
                  {entity.name}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="pt-2 border-t border-border/50">
          <p className="text-xs text-muted-foreground">
            {summary.exchangeCount} exchanges
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

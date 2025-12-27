import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Users, FolderKanban, BookOpen, Brain } from "lucide-react";
import { getKnowledgeProfile } from "@/lib/database";
import type { KnowledgeProfile } from "@/types";

interface KnowledgeProfileCardProps {
  refreshTrigger?: number;
}

export const KnowledgeProfileCard = ({
  refreshTrigger,
}: KnowledgeProfileCardProps) => {
  const [profile, setProfile] = useState<KnowledgeProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const data = await getKnowledgeProfile();
      setProfile(data);
    } catch (error) {
      console.error("Failed to load profile:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, [refreshTrigger]);

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  if (loading) {
    return (
      <Card className="shadow-none border border-border/70 rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Knowledge Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!profile || !profile.summary) {
    return (
      <Card className="shadow-none border border-border/70 rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Knowledge Profile
          </CardTitle>
          <CardDescription>
            Compacted from your meeting summaries
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Brain className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              No knowledge profile yet
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              A profile is created after compacting meeting summaries
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none border border-border/70 rounded-xl">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="h-4 w-4" />
              Knowledge Profile
            </CardTitle>
            <CardDescription>
              {profile.sourceCount} summaries compacted
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            Last updated: {formatDate(profile.lastCompacted)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground bg-accent/30 p-3 rounded-lg">
            {profile.summary}
          </p>
        </div>

        {/* Key People */}
        {profile.keyPeople.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Users className="h-3.5 w-3.5" />
              Key People
            </h4>
            <div className="grid gap-2">
              {profile.keyPeople.map((person, i) => (
                <div
                  key={i}
                  className="text-sm p-2 rounded-lg bg-accent/20 border border-border/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{person.name}</span>
                    {person.role && (
                      <Badge variant="secondary" className="text-xs">
                        {person.role}
                      </Badge>
                    )}
                  </div>
                  {person.relationship && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {person.relationship}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Key Projects */}
        {profile.keyProjects.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <FolderKanban className="h-3.5 w-3.5" />
              Key Projects
            </h4>
            <div className="grid gap-2">
              {profile.keyProjects.map((project, i) => (
                <div
                  key={i}
                  className="text-sm p-2 rounded-lg bg-accent/20 border border-border/50"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{project.name}</span>
                    <Badge
                      variant={
                        project.status === "active"
                          ? "default"
                          : project.status === "completed"
                          ? "secondary"
                          : "outline"
                      }
                      className="text-xs"
                    >
                      {project.status}
                    </Badge>
                  </div>
                  {project.description && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {project.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Terminology */}
        {profile.terminology.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <BookOpen className="h-3.5 w-3.5" />
              Domain Terms
            </h4>
            <div className="grid gap-2">
              {profile.terminology.map((term, i) => (
                <div
                  key={i}
                  className="text-sm p-2 rounded-lg bg-accent/20 border border-border/50"
                >
                  <span className="font-medium">{term.term}</span>
                  {term.meaning && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {term.meaning}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

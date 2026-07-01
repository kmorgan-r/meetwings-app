// Mock data for enhanced meeting summaries UI
// This demonstrates the new features from the website screenshots
//
// SCAFFOLDING — not yet wired into the app. Feeds the upcoming context-memory
// enhancement (titles, durations, action-item status, knowledge profile).
// TODO(context-memory): consume via SummaryList `mockSummaries` prop. Summaries
// and the knowledge profile are annotated against the canonical @/types so the
// compiler flags drift. MockActionItem stays local: the richer per-item shape
// (priority/status/dueDate) has no canonical equivalent yet — the real @/types
// ActionItem is minimal ({ text, assignee?, status }). Remove when feature ships.

import type { MeetingSummary, KnowledgeProfile } from "@/types";

// Mock enhanced meeting summary data
export const MOCK_ENHANCED_SUMMARIES: MeetingSummary[] = [
  {
    id: "mock-1",
    conversationId: "conv-1",
    title: "Product Roadmap Planning", // NEW: Auto-generated title
    summary: "Discussed Q1 product priorities, decided to prioritize dark mode feature for next sprint, and planned beta program launch with 50 early users. Team aligned on API v2 migration timeline for Q2 2026.",
    topics: ["Product Strategy", "Sprint Planning", "API Migration"],
    actionItems: [
      "Sarah: Design dark mode mockups by Friday",
      "John: Draft beta program requirements",
      "Team: Review competitor analysis doc"
    ],
    nextSteps: [ // NEW: Separate from action items
      "Schedule follow-up for Monday 10am",
      "Share summary with stakeholders"
    ],
    decisions: [
      "Prioritize dark mode feature for next sprint",
      "Move API v2 migration to Q2 2026",
      "Launch beta program with 50 early users"
    ],
    participants: ["Sarah", "John", "Emma", "Michael"],
    goals: [ // NEW: Goals discussed
      "Launch new product features by end of Q1",
      "Improve user retention by 20%",
      "Complete API v2 migration by Q2"
    ],
    teamUpdates: [ // NEW: Team status updates
      "Sarah completed authentication module",
      "Design team finished dashboard mockups",
      "Marketing campaign performing 45% above target"
    ],
    exchangeCount: 24,
    durationSeconds: 2700, // NEW: 45 minutes
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "mock-2",
    conversationId: "conv-2",
    title: "Client Onboarding Discussion",
    summary: "Reviewed requirements for new enterprise client. Discussed custom branding needs, SSO integration timeline, and training schedule for their team of 200 users.",
    topics: ["Client Onboarding", "SSO Integration", "Training"],
    actionItems: [
      "Alex: Prepare custom branding proposal",
      "Sarah: Set up SSO test environment",
      "John: Schedule training sessions"
    ],
    nextSteps: [
      "Send proposal to client by EOW",
      "Schedule kickoff call for next Tuesday"
    ],
    decisions: [
      "Offer premium support tier for first 3 months",
      "Custom branding available in 2-week timeline",
      "SSO integration to be completed before training"
    ],
    participants: ["Alex", "Sarah", "John"],
    goals: [
      "Onboard client successfully by end of month",
      "Ensure smooth SSO integration",
      "Train all 200 users within 2 weeks"
    ],
    teamUpdates: [
      "Alex closed 3 deals this week",
      "Support team handling 50+ tickets daily",
      "New developer started on Monday"
    ],
    exchangeCount: 18,
    durationSeconds: 1800, // 30 minutes
    createdAt: Date.now() - 1800000,
    updatedAt: Date.now() - 1800000,
  },
  {
    id: "mock-3",
    conversationId: "conv-3",
    title: "Sprint Retrospective",
    summary: "Team reflected on completed sprint. Identified blockers with API documentation and agreed to improve code review turnaround time. Celebrated shipping dark mode feature ahead of schedule.",
    topics: ["Retrospective", "Process Improvement", "Team Performance"],
    actionItems: [
      "Emma: Update API documentation by Wednesday",
      "Michael: Set up automated code review reminders",
      "Team: Complete anonymous feedback survey"
    ],
    nextSteps: [
      "Implement improvements in next sprint",
      "Review feedback survey results next week"
    ],
    decisions: [
      "Code reviews must be completed within 24 hours",
      "API documentation to be updated weekly",
      "Add daily standup at 10am instead of 9am"
    ],
    participants: ["Emma", "Michael", "Sarah", "John", "Alex"],
    goals: [
      "Reduce code review cycle time to under 24 hours",
      "Improve API documentation quality",
      "Increase team satisfaction scores"
    ],
    teamUpdates: [
      "Dark mode feature shipped ahead of schedule",
      "Emma received engineering excellence award",
      "Team velocity increased by 15% this sprint"
    ],
    exchangeCount: 32,
    durationSeconds: 3600, // 60 minutes
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 3600000,
  },
];

// Mock action items with assignees (for the new action_items table structure)
export interface MockActionItem {
  id: string;
  summaryId: string;
  description: string;
  assignee: string | null;
  priority: 'high' | 'normal' | 'low';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  dueDate: number | null;
  createdAt: number;
  updatedAt: number;
}

export const MOCK_ACTION_ITEMS: Record<string, MockActionItem[]> = {
  "mock-1": [
    {
      id: "action-1",
      summaryId: "mock-1",
      description: "Design dark mode mockups by Friday",
      assignee: "Sarah",
      priority: "high",
      status: "in_progress",
      dueDate: Date.now() + 172800000, // 2 days from now
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-2",
      summaryId: "mock-1",
      description: "Draft beta program requirements",
      assignee: "John",
      priority: "normal",
      status: "pending",
      dueDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-3",
      summaryId: "mock-1",
      description: "Review competitor analysis doc",
      assignee: null, // Assigned to "Team"
      priority: "normal",
      status: "pending",
      dueDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
  "mock-2": [
    {
      id: "action-4",
      summaryId: "mock-2",
      description: "Prepare custom branding proposal",
      assignee: "Alex",
      priority: "high",
      status: "pending",
      dueDate: Date.now() + 259200000, // 3 days from now
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-5",
      summaryId: "mock-2",
      description: "Set up SSO test environment",
      assignee: "Sarah",
      priority: "high",
      status: "pending",
      dueDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-6",
      summaryId: "mock-2",
      description: "Schedule training sessions",
      assignee: "John",
      priority: "normal",
      status: "pending",
      dueDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
  "mock-3": [
    {
      id: "action-7",
      summaryId: "mock-3",
      description: "Update API documentation by Wednesday",
      assignee: "Emma",
      priority: "high",
      status: "in_progress",
      dueDate: Date.now() + 86400000, // 1 day from now
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-8",
      summaryId: "mock-3",
      description: "Set up automated code review reminders",
      assignee: "Michael",
      priority: "normal",
      status: "pending",
      dueDate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "action-9",
      summaryId: "mock-3",
      description: "Complete anonymous feedback survey",
      assignee: null, // Team task
      priority: "low",
      status: "pending",
      dueDate: Date.now() + 604800000, // 7 days from now
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
};

// Mock enhanced knowledge profile
export const MOCK_KNOWLEDGE_PROFILE: KnowledgeProfile = {
  id: "profile",
  summary: "Working on Q1 product launch with focus on dark mode feature, API v2 migration, and enterprise client onboarding. Leading a team of 5 engineers and collaborating with design and marketing teams.",
  keyPeople: [
    { name: "Sarah", role: "Senior Engineer", relationship: "Tech lead on authentication and dark mode" },
    { name: "John", role: "Product Manager", relationship: "Coordinates roadmap and beta program" },
    { name: "Emma", role: "Engineering Manager", relationship: "Manages team velocity and process improvements" },
    { name: "Alex", role: "Sales Lead", relationship: "Handles enterprise client relationships" },
  ],
  keyProjects: [
    { name: "Dark Mode Feature", status: "active", description: "User-requested feature for Q1 launch" },
    { name: "API v2 Migration", status: "planning", description: "Major infrastructure upgrade planned for Q2" },
    { name: "Beta Program", status: "active", description: "50 early users testing new features" },
  ],
  terminology: [
    { term: "SSO", meaning: "Single Sign-On authentication integration" },
    { term: "Code review turnaround", meaning: "Time from PR submission to approval" },
  ],
  recentGoals: [
    "Launch new product features by end of Q1",
    "Improve user retention by 20%",
    "Onboard enterprise client with 200 users",
    "Reduce code review cycle time to under 24 hours",
  ],
  recentDecisions: [
    "Prioritize dark mode feature for next sprint",
    "Move API v2 migration to Q2 2026",
    "Launch beta program with 50 early users",
    "Code reviews must be completed within 24 hours",
    "Offer premium support tier for enterprise client",
  ],
  recentTeamUpdates: [
    "Sarah completed authentication module",
    "Design team finished dashboard mockups",
    "Marketing campaign performing 45% above target",
    "Dark mode feature shipped ahead of schedule",
    "Emma received engineering excellence award",
    "Team velocity increased by 15% this sprint",
  ],
  lastCompacted: Date.now(),
  sourceCount: 3,
};

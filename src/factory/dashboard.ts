/** Shapes of the read-only GitHub data behind the web console's factory page. */
export interface FactoryIssue { number: number; title: string; state: string; updatedAt: string; url: string; labels?: { name: string }[] }
export interface FactoryPullRequest { number: number; title: string; state: string; updatedAt: string; url: string; isDraft?: boolean; reviewDecision?: string | null }
export interface FactoryActivity { type: string; createdAt: string; actor?: string; url?: string; action?: string; merged?: boolean; details?: string }
export interface FactoryRepositorySnapshot { repository: string; issues: FactoryIssue[]; pullRequests: FactoryPullRequest[]; activity: FactoryActivity[]; activityCoverage?: string; error?: string }

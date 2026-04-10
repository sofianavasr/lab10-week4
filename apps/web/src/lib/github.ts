const GITHUB_API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...headers(token), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  private: boolean;
  language: string | null;
  updated_at: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  created_at: string;
  user: { login: string } | null;
}

export async function githubListRepos(
  token: string,
  perPage = 10
): Promise<GitHubRepo[]> {
  return ghFetch<GitHubRepo[]>(
    token,
    `/user/repos?sort=updated&per_page=${perPage}`
  );
}

export async function githubListIssues(
  token: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open"
): Promise<GitHubIssue[]> {
  return ghFetch<GitHubIssue[]>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}`
  );
}

export async function githubCreateIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<GitHubIssue> {
  return ghFetch<GitHubIssue>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    }
  );
}

export async function githubCreateRepo(
  token: string,
  name: string,
  description: string,
  isPrivate: boolean
): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>(token, "/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description,
      private: isPrivate,
      auto_init: true,
    }),
  });
}

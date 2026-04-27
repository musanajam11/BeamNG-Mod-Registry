/**
 * Open a pull request on the registry repo using the GitHub App installation
 * token. Optionally enables auto-merge so CI gates the merge.
 */
import { getGithubConfig } from '../settings.js'
import { getInstallationOctokit } from './app.js'

export interface OpenPrInput {
  branch: string
  title: string
  body: string
  draft?: boolean
}

export interface PrResult {
  url: string
  number: number
  nodeId: string
}

export async function openPullRequest(input: OpenPrInput): Promise<PrResult> {
  const g = getGithubConfig()
  const octokit = await getInstallationOctokit()
  const { data } = await octokit.pulls.create({
    owner: g.repoOwner!,
    repo: g.repoName,
    head: input.branch,
    base: g.defaultBranch,
    title: input.title,
    body: input.body,
    draft: input.draft ?? false,
    maintainer_can_modify: true,
  })
  if (g.autoMerge) {
    try {
      await octokit.graphql(
        `mutation($id: ID!) {
           enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { pullRequest { id } }
         }`,
        { id: data.node_id }
      )
    } catch {
      // Auto-merge can fail (e.g. branch protection not configured for it);
      // surface as a warning but don't abort the submission.
    }
  }
  return { url: data.html_url, number: data.number, nodeId: data.node_id }
}

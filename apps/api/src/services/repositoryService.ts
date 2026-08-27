import type { RepositoryRef } from "@codeflow/shared-types";
import { isMongoConnected } from "../db/connectMongo.js";
import { RepoModel } from "../db/models/RepoModel.js";

export interface NormalizedRepository {
  repository: RepositoryRef;
  fullName: string;
  branch: string;
  commitSha: string;
}

const inMemoryRepos = new Map<string, unknown>();

export function normalizeRepositoryForCache(repository: RepositoryRef): NormalizedRepository {
  const owner = repository.owner ?? "unknown";
  const name = repository.name;
  const branch = repository.branch ?? "main";
  const fullName = `${owner}/${name}`;
  // A PLACEHOLDER until Ingest clones and resolves the real HEAD SHA (the worker then
  // stamps the resolved value onto the job). Deliberately not a valid hex SHA so it can
  // never be mistaken for one, and stable per owner/name/branch so repeat submissions of
  // the same ref produce the same job payload.
  const commitSha = `pending-${sanitizeCachePart(owner)}-${sanitizeCachePart(name)}-${sanitizeCachePart(branch)}`;

  return {
    repository: {
      ...repository,
      owner,
      repo: name,
      branch,
      url: repository.url ?? `https://github.com/${owner}/${name}`,
    },
    fullName,
    branch,
    commitSha,
  };
}

export async function upsertRepository(input: NormalizedRepository) {
  const payload = {
    provider: "github",
    owner: input.repository.owner,
    name: input.repository.name,
    fullName: input.fullName,
    defaultBranch: input.branch,
    visibility: "public",
    cloneUrl: input.repository.url,
    lastAnalyzedAt: new Date(),
  };

  if (!isMongoConnected()) {
    inMemoryRepos.set(input.fullName, payload);
    return payload;
  }

  return RepoModel.findOneAndUpdate(
    { fullName: input.fullName },
    {
      $set: payload,
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { returnDocument: "after", upsert: true },
  ).lean();
}

export function clearRepositoryCacheForTests() {
  inMemoryRepos.clear();
}

function sanitizeCachePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

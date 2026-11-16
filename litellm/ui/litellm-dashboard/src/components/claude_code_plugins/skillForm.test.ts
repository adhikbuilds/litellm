import { describe, expect, it } from "vitest";
import {
  buildSkillImport,
  buildSkillMetadata,
  buildSkillRegistration,
  buildSkillUpdate,
  buildSkillUploadMetadata,
  skillFormSchema,
  skillFormValues,
} from "./skillForm";
import type { SkillHubSkill } from "./types";

const skill: SkillHubSkill = {
  id: "skill-1",
  name: "shared-skill",
  version: "2.7.4",
  description: "Published instructions",
  source: { source: "github", repo: "example/skills", ref: "release", sha: "pinned-commit" },
  keywords: ["workflow", "tools"],
  domain: "Engineering",
  namespace: "workflows",
  visibility: "public",
  security_scan_passed: false,
  updated_at: "2026-10-20T00:00:00Z",
};

describe("skill form payloads", () => {
  it.each([["sales, finance", "review"], ["  workflow  ", "review", "review"], [], null])(
    "leaves stored keywords untouched during another metadata edit: %j",
    (keywords) => {
      const published = { ...skill, keywords };
      const values = skillFormValues(published);
      expect(values.version).toBe("");
      const expected = {
        description: "Updated instructions",
        version: null,
        expected_updated_at: skill.updated_at,
      };
      expect(buildSkillMetadata({ ...values, description: "Updated instructions" }, published)).toEqual(expected);
    },
  );

  it("parses intentional edits and clears blank metadata without changing the source", () => {
    const values = {
      ...skillFormValues(skill),
      domain: "",
      namespace: "",
      description: "",
      keywords: "security, review",
      version: "3.0.0",
    };
    const expected = {
      description: null,
      domain: null,
      namespace: null,
      keywords: ["security", "review"],
      version: "3.0.0",
      expected_updated_at: skill.updated_at,
    };
    expect(buildSkillMetadata(values, skill)).toEqual(expected);
    expect(buildSkillMetadata({ ...values, keywords: "" }, skill).keywords).toEqual([]);
  });

  it("leaves source URL parsing to the API", () => {
    const values = { ...skillFormValues(), url: "https://github.com/example/skills/tree/release/v2/review" };
    expect(buildSkillImport(values)).toEqual({ url: values.url });
  });

  it("omits upload metadata unless a registry name was chosen", () => {
    expect(buildSkillUploadMetadata(skillFormValues())).toBeUndefined();
    const values = { ...skillFormValues(), name: "registry-alias", version: "2.0.0" };
    expect(buildSkillUploadMetadata(values)).toEqual({ name: "registry-alias", version: "2.0.0" });
  });

  it("sends only supported metadata and source fields for uploads, imports and registrations", () => {
    const values = {
      ...skillFormValues(),
      name: "registry-alias",
      description: "Registry description",
      domain: "Engineering",
      namespace: "tools",
      keywords: "review, quality",
      authorName: "Maintainer",
      authorEmail: "maintainer@example.test",
      category: "Productivity",
      homepage: "https://example.test/skill",
      version: "3.1.0",
      url: "https://skills.sh/example/skills/original-name",
      skill: "original-name",
      ref: "release/v3",
      path: "skills/original-name",
      archiveFile: new File(["legacy archive"], "skill.zip"),
      sha256: "a".repeat(64),
    };
    const metadata = {
      name: "registry-alias",
      description: "Registry description",
      domain: "Engineering",
      namespace: "tools",
      keywords: ["review", "quality"],
      author: { name: "Maintainer", email: "maintainer@example.test" },
      category: "Productivity",
      homepage: "https://example.test/skill",
      version: "3.1.0",
    };
    const expectedImport = {
      url: values.url,
      skill: values.skill,
      ref: values.ref,
      path: values.path,
      version: values.version,
      metadata,
    };
    expect(buildSkillUploadMetadata(values)).toEqual(metadata);
    expect(buildSkillImport(values)).toEqual(expectedImport);
    const registration = {
      ...values,
      mode: "register" as const,
      url: "https://git.example.test/team/skills.git",
    };
    expect(buildSkillRegistration(registration)).toEqual({
      ...metadata,
      source: { source: "git-subdir", url: registration.url, path: values.path },
    });
  });

  it.each([
    ["github.com/example/skill", "", { source: "github", repo: "example/skill" }],
    ["git@git.example.test:team/skill.git", "", { source: "url", url: "git@git.example.test:team/skill.git" }],
    [
      "https://git.example.test/team/skills.git",
      "skills/review",
      {
        source: "git-subdir",
        url: "https://git.example.test/team/skills.git",
        path: "skills/review",
      },
    ],
    [
      "https://artifacts.example.test/skill.zip",
      "",
      { source: "archive", url: "https://artifacts.example.test/skill.zip" },
    ],
  ])("registers %s as a reference without portable import options", (url, path, source) => {
    const values = {
      ...skillFormValues(),
      name: "review",
      url,
      path,
      ref: "unused-import-ref",
      skill: "unused-selector",
    };
    expect(buildSkillRegistration(values)).toEqual({ name: "review", source });
  });

  it("preserves the supplied archive digest", () => {
    const sha256 = "aBcD".repeat(16);
    const values = {
      ...skillFormValues(),
      name: "review",
      url: "https://artifacts.example.test/skill.zip",
      sha256,
    };
    expect(buildSkillRegistration(values)).toEqual({
      name: "review",
      source: { source: "archive", url: "https://artifacts.example.test/skill.zip", sha256 },
    });
  });

  it.each(["", " \t "])("clears every editable metadata field when set to %j", (blank) => {
    const published: SkillHubSkill = {
      ...skill,
      author: { name: "Maintainer", email: "maintainer@example.test" },
      category: "Quality",
      homepage: "https://example.test/skill",
    };
    const initial = skillFormValues(published);
    expect(buildSkillMetadata(initial, published)).toEqual({
      version: null,
      expected_updated_at: published.updated_at,
    });
    const clearedValues = {
      ...initial,
      description: blank,
      domain: blank,
      namespace: blank,
      keywords: blank,
      authorName: blank,
      authorEmail: blank,
      category: blank,
      homepage: blank,
      version: blank,
    };
    const validated = skillFormSchema(published).parse(clearedValues);
    const clearedMetadata = {
      description: null,
      domain: null,
      namespace: null,
      keywords: [],
      author: null,
      category: null,
      homepage: null,
      version: null,
      expected_updated_at: published.updated_at,
    };
    expect(buildSkillMetadata(validated, published)).toEqual(clearedMetadata);
    expect(buildSkillUpdate(validated, published)).toEqual(clearedMetadata);
    const emailCleared = skillFormSchema(published).parse({ ...initial, authorEmail: blank });
    expect(buildSkillMetadata(emailCleared, published)).toEqual({
      author: { name: "Maintainer", email: null },
      version: null,
      expected_updated_at: published.updated_at,
    });
  });

  it("preserves unchanged stored text and optional fields during a version-only edit", () => {
    const published: SkillHubSkill = {
      ...skill,
      description: "  Original instructions\n",
      domain: " Engineering ",
      namespace: " workflows ",
      author: null,
      category: null,
      homepage: null,
    };
    const values = { ...skillFormValues(published), version: "3.0.0" };
    const metadata = buildSkillMetadata(values, published);
    expect(metadata).toEqual({ version: values.version, expected_updated_at: published.updated_at });
  });

  it("only includes source when replacing a published source and never for pending metadata", () => {
    const managed: SkillHubSkill = {
      ...skill,
      source: { source: "archive", url: "/skill-hub/skills/shared-skill/archive", sha256: "a".repeat(64) },
    };
    const initial = skillFormValues(managed);
    expect(initial.url).toBe("");
    expect(buildSkillUpdate(initial, managed)).not.toHaveProperty("source");
    const replacement = { ...initial, mode: "replace" as const, url: "https://git.example.test/team/new.git" };
    expect(buildSkillUpdate(replacement, managed).source).toEqual({
      source: "url",
      url: "https://git.example.test/team/new.git",
    });
    expect(buildSkillMetadata(replacement, managed)).not.toHaveProperty("source");
    expect(buildSkillUpdate({ ...replacement, mode: "metadata" }, managed)).not.toHaveProperty("source");
  });
});

describe("skill form validation", () => {
  const archiveFile = new File(["legacy SKILL.md without frontmatter"], "legacy.zip");

  it.each(["unchanged", "edited"])("preserves a long %s registry description when editing metadata", (state) => {
    const description = "Registry description.".repeat(80);
    const published = { ...skill, description: state === "unchanged" ? description : skill.description };
    const values = { ...skillFormValues(published), description };
    const validated = skillFormSchema(published).parse(values);
    expect({ ...published, ...buildSkillMetadata(validated, published) }.description).toBe(description);
    expect({ ...published, ...buildSkillUpdate(validated, published) }.description).toBe(description);
  });

  it.each(["upload", "import", "register"] as const)("preserves a long registry description during %s", (mode) => {
    const description = "Registry description.".repeat(80);
    const values = {
      ...skillFormValues(),
      mode,
      archiveFile,
      url: "https://github.com/example/skills",
      name: "registry-alias",
      description,
    };
    const validated = skillFormSchema().parse(values);
    expect(buildSkillUploadMetadata(validated)?.description).toBe(description);
  });

  it.each([
    ["description", "Custom description"],
    ["domain", "Engineering"],
    ["namespace", "tools"],
    ["keywords", "review"],
    ["authorName", "Maintainer"],
    ["authorEmail", "maintainer@example.test"],
    ["category", "Review"],
    ["homepage", "https://example.test/skill"],
  ])("requires a registry name when the %s override is entered", (field, value) => {
    for (const mode of ["upload", "import"] as const) {
      const values = {
        ...skillFormValues(),
        mode,
        archiveFile,
        url: "https://github.com/example/skills",
        [field]: value,
      };
      const result = skillFormSchema().safeParse(values);
      expect(result.error?.issues).toContainEqual(expect.objectContaining({ path: ["name"] }));
    }
  });

  it.each(["upload", "import"] as const)(
    "requires a name for custom %s metadata but leaves the default flow intact",
    (mode) => {
      const values = { ...skillFormValues(), mode, archiveFile, url: "https://github.com/example/skills" };
      expect(skillFormSchema().safeParse(values).success).toBe(true);
      expect(skillFormSchema().safeParse({ ...values, description: "Custom metadata" }).success).toBe(false);
      expect(
        skillFormSchema().safeParse({ ...values, description: "Custom metadata", name: "registry-alias" }).success,
      ).toBe(true);
    },
  );

  it("requires a reference name and validates the source without affecting portable import", () => {
    const values = { ...skillFormValues(), mode: "register" as const, url: "not a repository" };
    expect(skillFormSchema().safeParse(values).success).toBe(false);
    expect(buildSkillRegistration(values)).toBeNull();
    expect(
      skillFormSchema().safeParse({ ...values, name: "skill", url: "git@git.example.test:team/skill.git" }).success,
    ).toBe(true);
  });

  it.each(["register", "replace"] as const)("validates an optional archive digest during %s", (mode) => {
    const published = mode === "replace" ? skill : undefined;
    const schema = skillFormSchema(published);
    const values = {
      ...skillFormValues(published),
      mode,
      name: "skill",
      url: "https://artifacts.example.test/skill.zip",
    };
    expect(schema.safeParse(values).success).toBe(true);
    expect(schema.safeParse({ ...values, sha256: "invalid" }).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["sha256"] }),
    );
    expect(schema.safeParse({ ...values, sha256: ` ${"aBcD".repeat(16)} ` }).success).toBe(true);
  });

  it("requires an author name for an email and permits version-only archive replacement", () => {
    const values = {
      ...skillFormValues(),
      mode: "register" as const,
      name: "skill",
      url: "github.com/example/skill",
      authorEmail: "author@example.test",
    };
    expect(skillFormSchema().safeParse(values).success).toBe(false);
    expect(skillFormSchema().safeParse({ ...values, authorName: "Maintainer" }).success).toBe(true);
    const replacement = { ...skillFormValues(skill), mode: "upload", archiveFile, version: "3.0.0" };
    expect(skillFormSchema(skill).safeParse(replacement).success).toBe(true);
  });
});

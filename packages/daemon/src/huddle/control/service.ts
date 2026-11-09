import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  huddleCreateSchema,
  huddleDuplicateSchema,
  type HuddleDuplicate,
  huddleLocationSchema,
  huddleOpenSchema,
  huddleValidateSchema,
  type HuddleValidate,
  huddleSaveSchema,
  huddleSaveSourceSchema,
  type HuddleSaveSource,
  huddleInstallTemplateSchema,
  type HuddleInstallTemplate,
  type HuddleCreate,
  type HuddleLocation,
  type HuddleOpen,
  type HuddleSave,
} from '@puddle/shared';
import type { HuddlePlacements } from '../../db/stores/huddle/placements.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { RepoStore } from '../../db/stores/repos.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
import type { RuntimeLauncher } from '../../runtime/lifecycle/launcher.js';
import type { StorageMonitor } from '../../storage/monitor.js';
import {
  requireHuddleRuntimeSelection,
  type HuddleRuntimeRelease,
} from '../../runtime/huddle/control/release.js';
import { ApiError } from '../../http/errors.js';
import { captureHuddleDefinition, type HuddleDefinitionSnapshot } from '../definitions/capture.js';
import { createHuddleDefinition } from '../definitions/create.js';
import { captureHuddleCopy, publishHuddleCopy } from '../definitions/duplicate.js';
import { saveHuddleDefinition, saveHuddleSource } from '../definitions/save.js';
import { discoverHuddleDefinitions } from '../definitions/discovery.js';
import { installHuddleTemplate } from '../templates/install.js';
import { coreHuddleComponents } from '@puddle/shared';
import { checkHuddleSource } from '../validation/check.js';

interface Dependencies {
  home: string;
  profiles: Pick<ProfileStore, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
  repos: Pick<RepoStore, 'get'>;
  placements: HuddlePlacements;
  worktrees: Pick<WorktreeManager, 'listWorktrees' | 'runGitMutation'>;
  launcher?: Pick<RuntimeLauncher, 'checkHuddleAvailable'>;
  storage?: Pick<StorageMonitor, 'assertAdmission'>;
  changed(projectId: string): void;
}
const unavailable = () =>
  ApiError.conflict(
    'huddle_runtime_unavailable',
    'Select an installed runtime with huddle support and an available runtime lifetime',
  );
interface Location {
  worktree: string;
  branch: string;
  worktrees: string[];
  check(): void;
}

/** Local/SSH authoring only. Saving/opening never launches, arms or prompts an agent. */
export class HuddleService {
  constructor(private readonly deps: Dependencies) {}

  async availability(profile: string, authority: () => boolean) {
    this.checkProfile(profile, authority);
    try {
      const support = await this.support();
      this.checkProfile(profile, authority);
      return {
        available: true as const,
        build: support.selected.build,
        lifetime: support.lifetime,
      };
    } catch {
      this.checkProfile(profile, authority);
      return { available: false as const, reason: unavailable().message };
    }
  }

  discover(profile: string, raw: HuddleLocation, authority: () => boolean) {
    return this.atLocation(
      profile,
      huddleLocationSchema.parse(raw),
      authority,
      async (location) => {
        const result = await discoverHuddleDefinitions(location.worktree, coreHuddleComponents);
        location.check();
        return result;
      },
    );
  }

  inspect(profile: string, raw: HuddleOpen, authority: () => boolean) {
    const input = huddleOpenSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      const snapshot = await this.capture(location.worktree, input.huddle_id);
      location.check();
      return this.document(snapshot);
    });
  }

  source(profile: string, raw: HuddleOpen, authority: () => boolean) {
    return this.withSnapshot(profile, raw, authority, async (snapshot) => ({
      document: this.document(snapshot),
      files: snapshot.files,
    }));
  }

  validate(profile: string, raw: HuddleValidate, authority: () => boolean) {
    const { fixtures = [], ...input } = huddleValidateSchema.parse(raw);
    return this.withSnapshot(profile, input, authority, (snapshot, location) =>
      checkHuddleSource(snapshot, location.worktree, fixtures, location.check),
    );
  }

  saveSource(profile: string, raw: HuddleSaveSource, authority: () => boolean) {
    const input = huddleSaveSourceSchema.parse(raw);
    return this.saveSnapshot(profile, input, authority, (location, snapshot) =>
      saveHuddleSource(location.worktree, snapshot, input.edit, location.check),
    ).then((saved) => ({ document: this.document(saved), files: saved.files }));
  }

  /** Internal execution admission shares the same registered source scope and repository lock. */
  withSnapshot<T>(
    profile: string,
    raw: HuddleOpen,
    authority: () => boolean,
    use: (snapshot: HuddleDefinitionSnapshot, location: Location) => Promise<T>,
  ) {
    const input = huddleOpenSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      const snapshot = await this.capture(location.worktree, input.huddle_id);
      location.check();
      return use(snapshot, location);
    });
  }

  create(profile: string, raw: HuddleCreate, authority: () => boolean) {
    const input = huddleCreateSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      const support = await this.support();
      await this.deps.storage?.assertAdmission([this.deps.home, location.worktree]);
      location.check();
      this.requireSelection(support.selected);
      const definition = createHuddleDefinition(location.worktree, input.name, input.template);
      const snapshot = await this.capture(location.worktree, definition.id);
      location.check();
      this.requireSelection(support.selected);
      return this.place(input.project_id, location, snapshot);
    });
  }

  duplicate(profile: string, raw: HuddleDuplicate, authority: () => boolean) {
    const input = huddleDuplicateSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      const support = await this.support();
      await this.deps.storage?.assertAdmission([this.deps.home, location.worktree]);
      location.check();
      this.requireSelection(support.selected);
      const source = await this.capture(location.worktree, input.huddle_id);
      if (source.digest !== input.expected_digest)
        throw ApiError.conflict(
          'huddle_source_changed',
          'Huddle source changed; inspect it before copying',
        );
      const copy = await captureHuddleCopy(location.worktree, source);
      location.check();
      this.requireSelection(support.selected);
      const id = publishHuddleCopy(location.worktree, input.name, copy);
      const snapshot = await this.capture(location.worktree, id);
      location.check();
      this.requireSelection(support.selected);
      return this.place(input.project_id, location, snapshot);
    });
  }

  open(profile: string, raw: HuddleOpen, authority: () => boolean) {
    const input = huddleOpenSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      const snapshot = await this.capture(location.worktree, input.huddle_id);
      location.check();
      const previous = this.deps.placements.find(
        input.project_id,
        location.worktree,
        input.huddle_id,
      );
      // Existing placements remain inspectable if the default runtime changes.
      if (previous) return { session: previous, created: false, document: this.document(snapshot) };
      const support = await this.support();
      await this.deps.storage?.assertAdmission([this.deps.home]);
      location.check();
      this.requireSelection(support.selected);
      return this.place(input.project_id, location, snapshot);
    });
  }

  save(profile: string, raw: HuddleSave, authority: () => boolean) {
    const input = huddleSaveSchema.parse(raw);
    return this.saveSnapshot(profile, input, authority, (location, snapshot) =>
      saveHuddleDefinition(location.worktree, snapshot, input.edit, location.check),
    ).then((saved) => this.document(saved));
  }

  private saveSnapshot(
    profile: string,
    input: HuddleOpen & { expected_digest: string },
    authority: () => boolean,
    publish: (location: Location, snapshot: HuddleDefinitionSnapshot) => void,
  ) {
    return this.atLocation(profile, input, authority, async (location) => {
      const snapshot = await this.capture(location.worktree, input.huddle_id);
      location.check();
      if (snapshot.digest !== input.expected_digest)
        throw ApiError.conflict(
          'huddle_source_changed',
          'Huddle source changed; reload and reconcile your edits',
        );
      await this.deps.storage?.assertAdmission([location.worktree]);
      location.check();
      publish(location, snapshot);
      // Source is already saved if this observation fails. The caller must inspect
      // it after a lost reply, never replay with a freshly substituted digest.
      const saved = await this.capture(location.worktree, input.huddle_id);
      location.check();
      return saved;
    });
  }

  installTemplate(profile: string, raw: HuddleInstallTemplate, authority: () => boolean) {
    const input = huddleInstallTemplateSchema.parse(raw);
    return this.atLocation(profile, input, authority, async (location) => {
      await this.capture(location.worktree, input.huddle_id);
      await this.deps.storage?.assertAdmission([location.worktree]);
      location.check();
      return installHuddleTemplate(location.worktree, input, location.check);
    });
  }

  private place(
    projectId: string,
    location: { worktree: string; branch: string },
    snapshot: HuddleDefinitionSnapshot,
  ) {
    const result = this.deps.placements.open({
      projectId,
      ...location,
      huddleId: snapshot.definition.id,
      title: snapshot.definition.name,
    });
    if (result.created) this.deps.changed(projectId);
    return { ...result, document: this.document(snapshot) };
  }

  private document(snapshot: HuddleDefinitionSnapshot) {
    const { digest, definition, layout, components, diagnostics } = snapshot;
    return { digest, definition, ...(layout ? { layout } : {}), components, diagnostics };
  }

  private async capture(worktree: string, id: string) {
    try {
      return await captureHuddleDefinition(worktree, id, coreHuddleComponents);
    } catch (error) {
      throw ApiError.conflict(
        'huddle_definition_invalid',
        (error instanceof Error ? error.message : 'Cannot inspect huddle definition').slice(
          0,
          8192,
        ),
      );
    }
  }

  private async support() {
    if (!this.deps.launcher) throw unavailable();
    try {
      return await this.deps.launcher.checkHuddleAvailable();
    } catch {
      throw unavailable();
    }
  }

  private requireSelection(selected: HuddleRuntimeRelease) {
    try {
      requireHuddleRuntimeSelection(this.deps.home, selected);
    } catch {
      throw ApiError.conflict(
        'huddle_runtime_changed',
        'The selected runtime changed; inspect huddle availability before trying again',
      );
    }
  }

  private checkProfile(profile: string, authority: () => boolean) {
    if (!authority()) throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
    this.deps.profiles.get(profile);
  }

  private async atLocation<T>(
    profile: string,
    input: HuddleLocation,
    authority: () => boolean,
    action: (location: Location) => Promise<T>,
  ) {
    const check = () => {
      this.checkProfile(profile, authority);
      const project = this.deps.projects.get(input.project_id);
      if (project.profile_id !== profile)
        throw new ApiError(403, 'profile_scope', 'Project belongs to another profile');
      if (project.archived)
        throw ApiError.conflict(
          'project_archived',
          'Unarchive the project before opening its huddles',
        );
      return project;
    };
    const project = check();
    if (!isAbsolute(input.worktree))
      throw ApiError.badRequest('invalid_worktree', 'Choose an absolute registered worktree root');
    const repo = this.deps.repos.get(project.repo_id);
    return this.deps.worktrees.runGitMutation(repo.path, async () => {
      check();
      const worktree = await realpath(input.worktree).catch(() => null);
      if (!worktree) throw ApiError.badRequest('unknown_worktree', 'Worktree is missing');
      const roots = await this.deps.worktrees.listWorktrees(repo);
      const matches = [];
      const worktrees: string[] = [];
      for (const root of roots) {
        const canonical = await realpath(root.path).catch(() => null);
        if (canonical) worktrees.push(canonical);
        if (canonical === worktree) matches.push(root);
      }
      if (matches.length !== 1)
        throw ApiError.badRequest(
          'unknown_worktree',
          'Choose one registered worktree of this project',
        );
      check();
      return action({ worktree, branch: matches[0]!.branch ?? 'HEAD', worktrees, check });
    });
  }
}

import * as vscode from "vscode";
import { Filter, generateSvgUri, Group, Project } from "./utils";

type StoredFilter = {
  regex: string;
  color: string;
  isExclude?: boolean;
  isHighlighted?: boolean;
  isShown?: boolean;
};

type StoredGroup = {
  name: string;
  filters: StoredFilter[];
};

type StoredProject = {
  name: string;
  groups: StoredGroup[];
};

const SETTINGS_NAMESPACE = "log-analysis";
const PROJECTS_SETTING_KEY = "projects";
const STORE_IN_USER_SETTINGS_KEY = "storeInUserSettings";
const SYNC_FILTER_STATUS_KEY = "syncFilterStatus";

export function isUsingUserSettingsStorage(): boolean {
  return vscode.workspace
    .getConfiguration(SETTINGS_NAMESPACE)
    .get<boolean>(STORE_IN_USER_SETTINGS_KEY, false);
}

export function shouldSyncFilterStatus(): boolean {
  return vscode.workspace
    .getConfiguration(SETTINGS_NAMESPACE)
    .get<boolean>(SYNC_FILTER_STATUS_KEY, true);
}

function deserializeProjects(storedProjects: StoredProject[]): Project[] {
  const projects: Project[] = [];
  const syncFilterStatus = shouldSyncFilterStatus();
  try {
    storedProjects.map((p) => {
      const project: Project = {
        groups: [],
        name: p.name,
        id: `${Math.random()}`,
        selected: false,
      };
      p.groups.map((g) => {
        const group: Group = {
          filters: [],
          name: g.name as string,
          isHighlighted: true,
          isShown: true,
          id: `${Math.random()}`,
        };
        g.filters.map((f) => {
          const filterId = `${Math.random()}`;
          const isExclude = !!f.isExclude;
          const isHighlighted = syncFilterStatus
            ? (f.isHighlighted ?? true)
            : true;
          const isShown = syncFilterStatus ? (f.isShown ?? true) : true;
          const filter: Filter = {
            regex: new RegExp(f.regex),
            color: f.color as string,
            isHighlighted,
            isShown,
            id: filterId,
            iconPath: generateSvgUri(f.color, isHighlighted, isExclude),
            isExclude,
            count: 0,
          };
          group.filters.push(filter);
        });
        project.groups.push(group);
      });
      projects.push(project);
    });
  } catch {
    vscode.window.showErrorMessage("The settings content is invalid");
  }
  return projects;
}

export function serializeProjectsForStorage(projects: Project[]): StoredProject[] {
  const syncFilterStatus = shouldSyncFilterStatus();
  return projects.map((project) => ({
    name: project.name,
    groups: project.groups.map((group) => ({
      name: group.name,
      filters: group.filters.map((filter) => ({
        regex: filter.regex.source,
        color: filter.color,
        isExclude: filter.isExclude,
        isHighlighted: syncFilterStatus ? filter.isHighlighted : undefined,
        isShown: syncFilterStatus ? filter.isShown : undefined,
      })),
    })),
  }));
}

export function getProjectsConfigSnapshot(storageUri: vscode.Uri): string {
  void storageUri;
  if (isUsingUserSettingsStorage()) {
    const storedProjects = vscode.workspace
      .getConfiguration(SETTINGS_NAMESPACE)
      .get<StoredProject[]>(PROJECTS_SETTING_KEY, []) ?? [];
    return JSON.stringify(storedProjects);
  }
  return "[]";
}

export function openSettings(storageUri: vscode.Uri) {
  void storageUri;
  void vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@ext:XinyaYang0506.log-analysis"
  );
}

export function readSettings(storageUri: vscode.Uri): Project[] {
  void storageUri;
  if (isUsingUserSettingsStorage()) {
    const storedProjects = vscode.workspace
      .getConfiguration(SETTINGS_NAMESPACE)
      .get<StoredProject[]>(PROJECTS_SETTING_KEY, []) ?? [];
    return deserializeProjects(storedProjects);
  }

  return [];
}

export function saveSettings(storageUri: vscode.Uri, projects: Project[]) {
  void storageUri;
  const serializedProjects = serializeProjectsForStorage(projects);

  if (isUsingUserSettingsStorage()) {
    void vscode.workspace
      .getConfiguration(SETTINGS_NAMESPACE)
      .update(
        PROJECTS_SETTING_KEY,
        serializedProjects,
        vscode.ConfigurationTarget.Global
      )
      .then(
        undefined,
        () => vscode.window.showErrorMessage("Failed to save Log Analysis settings")
      );
    return;
  }
}

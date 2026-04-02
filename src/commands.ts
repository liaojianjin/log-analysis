import * as vscode from "vscode";
import { State } from "./extension";
import { getProjectsConfigSnapshot, readSettings, saveSettings } from "./settings";
import {
  Filter,
  Group,
  generateRandomColor,
  generateSvgUri,
  getProjectSelectedIndex,
  setProjectSelectedFlag,
  setStatusBarMessage,
} from "./utils";

function persistStateForCrossWindowSync(state: State): void {
  const selectedIndex = getProjectSelectedIndex(state.projects);
  if (selectedIndex === -1) {
    return;
  }
  state.projects[selectedIndex].groups = state.groups;
  saveSettings(state.globalStorageUri, state.projects);
  state.projectsConfigSnapshot = getProjectsConfigSnapshot(state.globalStorageUri);
}

export function applyHighlight(
  state: State,
  editors: readonly vscode.TextEditor[]
): void {
  // remove old decorations from all the text editor using the given decorationType
  state.decorations.forEach((decorationType) => decorationType.dispose());
  state.decorations = [];

  editors.forEach((editor) => {
    let sourceCode = editor.document.getText();
    const sourceCodeArr = sourceCode.split("\n");

    state.groups.forEach((group) => {
      //apply new decorations
      group.filters.forEach((filter) => {
        let filterCount = 0;
        //if filter's highlight is off, or this editor is in focus mode and filter is not shown, we don't want to put decorations
        //especially when a specific line fits more than one filter regex and some of them are shown while others are not.
        if (
          filter.isHighlighted &&
          (!editor.document.uri.toString().startsWith("focus:") ||
            filter.isShown)
        ) {
          let lineNumbers: number[] = [];
          for (let lineIdx = 0; lineIdx < sourceCodeArr.length; lineIdx++) {
            if (filter.regex.test(sourceCodeArr[lineIdx])) {
              lineNumbers.push(lineIdx);
            }
          }
          filterCount = lineNumbers.length;

          const decorationsArray = lineNumbers.map((lineIdx) => {
            return new vscode.Range(
              new vscode.Position(lineIdx, 0),
              new vscode.Position(lineIdx, 0) //position does not matter because isWholeLine is set to true
            );
          });
          let decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: filter.color,
            isWholeLine: true,
          });
          //store the decoration type for future removal
          state.decorations.push(decorationType);
          editor.setDecorations(decorationType, decorationsArray);
        }
        //filter.count represents the count of the lines for the activeEditor, so if the current editor is active, we update the count
        if (editor === vscode.window.activeTextEditor) {
          filter.count = filterCount;
        }
      });
    });
  });
}

//set bool for whether the lines matched the given filter will be kept for focus mode
export function setVisibility(
  isShown: boolean,
  treeItem: vscode.TreeItem,
  state: State
) {
  const id = treeItem.id;
  const group = state.groups.find((group) => group.id === id);
  if (group !== undefined) {
    group.isShown = isShown;
    group.filters.map((filter) => (filter.isShown = isShown));
  } else {
    state.groups.map((group) => {
      const filter = group.filters.find((filter) => filter.id === id);
      if (filter !== undefined) {
        filter.isShown = isShown;
      }
    });
  }
  refreshEditors(state);
  persistStateForCrossWindowSync(state);
}

function getFocusUri(originalUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse("focus:" + originalUri.toString());
}

function getOriginalUriFromFocusUri(focusUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.parse(focusUri.path);
}

function refreshFocusModeState(state: State): void {
  state.inFocusMode = vscode.window.visibleTextEditors.some(
    (editor) => editor.document.uri.scheme === "focus"
  );
}

function findVisibleFocusEditor(
  focusUri: vscode.Uri
): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === focusUri.toString()
  );
}

async function closeVisibleEditor(editor: vscode.TextEditor): Promise<void> {
  await vscode.window.showTextDocument(editor.document, {
    viewColumn: editor.viewColumn,
    preserveFocus: false,
    preview: false,
  });
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
}

async function openOriginalDocument(
  originalUri: vscode.Uri,
  viewColumn: vscode.ViewColumn | undefined
): Promise<void> {
  const originalDocument = await vscode.workspace.openTextDocument(originalUri);
  await vscode.window.showTextDocument(originalDocument, {
    viewColumn,
    preserveFocus: false,
    preview: false,
  });
}

//toggle focus mode for the active editor:
//1) original document -> open focus mode virtual document
//2) focus mode document -> close focus mode and switch back to original document
//3) original document with opened focus tab -> close the opened focus tab
export async function turnOnFocusMode(state: State) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  if (state.focusModeToggleInProgress) {
    return;
  }

  const activeUri = editor.document.uri;
  const viewColumn = editor.viewColumn;
  const isFocusDocument = activeUri.scheme === "focus";

  state.focusModeToggleInProgress = true;
  try {
    if (isFocusDocument) {
      const originalUri = getOriginalUriFromFocusUri(activeUri);
      await closeVisibleEditor(editor);
      await openOriginalDocument(originalUri, viewColumn);
      refreshFocusModeState(state);
      return;
    }

    const focusUri = getFocusUri(activeUri);
    const visibleFocusEditor = findVisibleFocusEditor(focusUri);
    if (visibleFocusEditor !== undefined) {
      await closeVisibleEditor(visibleFocusEditor);
      await vscode.window.showTextDocument(editor.document, {
        viewColumn,
        preserveFocus: false,
        preview: false,
      });
      refreshFocusModeState(state);
      return;
    }

    //because of the special schema, openTextDocument will use the focusProvider
    const focusDocument = await vscode.workspace.openTextDocument(focusUri);
    await vscode.window.showTextDocument(focusDocument, {
      viewColumn,
      preserveFocus: false,
      preview: false,
    });
    refreshFocusModeState(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    vscode.window.showErrorMessage(`Failed to toggle focus mode: ${message}`);
  } finally {
    state.focusModeToggleInProgress = false;
  }
}

export function deleteFilter(treeItem: vscode.TreeItem, state: State) {
  state.groups.map((group) => {
    const deleteIndex = group.filters.findIndex(
      (filter) => filter.id === treeItem.id
    );
    if (deleteIndex !== -1) {
      group.filters.splice(deleteIndex, 1);
    }
  });
  refreshEditors(state);
  persistStateForCrossWindowSync(state);
}

function createGroup(name: string): Group {
  return {
    filters: [],
    isHighlighted: true,
    isShown: true,
    name,
    id: `${Math.random()}`,
  };
}

type FilterColorQuickPickAction = "preset" | "custom" | "random" | "keep";
type FilterColorQuickPickItem = vscode.QuickPickItem & {
  action: FilterColorQuickPickAction;
  colorValue?: string;
};

const FILTER_COLOR_PRESETS: { name: string; color: string }[] = [
  { name: "Red", color: "#ef4444" },
  { name: "Orange", color: "#f97316" },
  { name: "Yellow", color: "#eab308" },
  { name: "Green", color: "#22c55e" },
  { name: "Teal", color: "#14b8a6" },
  { name: "Blue", color: "#3b82f6" },
  { name: "Purple", color: "#8b5cf6" },
  { name: "Pink", color: "#ec4899" },
  { name: "Gray", color: "#6b7280" },
];

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR_REGEX =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|0?\.\d+|1))?\s*\)$/;
const HSL_COLOR_REGEX =
  /^hsla?\(\s*-?\d{1,3}(?:\.\d+)?\s*(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|0?\.\d+|1))?\s*\)$/;
const COLOR_NAME_REGEX = /^[a-zA-Z]+$/;

function isValidCustomColorInput(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }
  return (
    HEX_COLOR_REGEX.test(normalized) ||
    RGB_COLOR_REGEX.test(normalized) ||
    HSL_COLOR_REGEX.test(normalized) ||
    COLOR_NAME_REGEX.test(normalized)
  );
}

async function pickFilterColor(
  randomColor: string,
  currentColor?: string
): Promise<string | undefined> {
  const items: FilterColorQuickPickItem[] = [];
  if (currentColor !== undefined) {
    items.push({
      label: `Keep current color (${currentColor})`,
      action: "keep",
      colorValue: currentColor,
    });
  }

  FILTER_COLOR_PRESETS.forEach((preset) => {
    items.push({
      label: `${preset.name} (${preset.color})`,
      description: "Preset color",
      action: "preset",
      colorValue: preset.color,
    });
  });
  items.push({
    label: `Random (${randomColor})`,
    description: "Generate random color",
    action: "random",
    colorValue: randomColor,
  });
  items.push({
    label: "Custom...",
    description: "Input your own color value",
    action: "custom",
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a filter color",
    ignoreFocusOut: false,
  });
  if (selected === undefined) {
    return undefined;
  }
  if (selected.action === "custom") {
    const customColor = await vscode.window.showInputBox({
      prompt: "[FILTER] Type color, e.g. #22c55e, rgb(34,197,94), hsl(142, 71%, 45%)",
      value: currentColor ?? randomColor,
      ignoreFocusOut: false,
      validateInput: (value) =>
        isValidCustomColorInput(value)
          ? null
          : "Invalid color format. Use hex/rgb/hsl/color-name.",
    });
    if (customColor === undefined) {
      return undefined;
    }
    return customColor.trim();
  }
  return selected.colorValue;
}

function resolveTargetGroup(
  treeItem: vscode.TreeItem | undefined,
  state: State
): Group | undefined {
  if (treeItem !== undefined) {
    return state.groups.find((group) => group.id === treeItem.id);
  }

  const config = vscode.workspace.getConfiguration("log-analysis");
  const useDefaultFilterGroup = config.get<boolean>("useDefaultFilterGroup", true);
  if (!useDefaultFilterGroup) {
    return undefined;
  }

  const defaultGroupName = config.get<string>("defaultFilterGroupName", "Default");
  const groupName =
    defaultGroupName.trim().length > 0 ? defaultGroupName.trim() : "Default";
  let defaultGroup = state.groups.find((group) => group.name === groupName);
  if (defaultGroup === undefined) {
    defaultGroup = createGroup(groupName);
    state.groups.push(defaultGroup);
  }

  return defaultGroup;
}

export async function addFilter(
  treeItem: vscode.TreeItem | undefined,
  state: State
): Promise<void> {
  const targetGroup = resolveTargetGroup(treeItem, state);
  if (targetGroup === undefined) {
    vscode.window.showErrorMessage(
      "Please create/select a filter group first, or enable 'Log Analysis: Use Default Filter Group'."
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(
    ["Add a filter", "Add an exclude filter"],
    {
      placeHolder: "Select filter type",
      ignoreFocusOut: false,
    }
  );
  if (!selected) {
    return;
  }

  const regexStr = await vscode.window.showInputBox({
    prompt: "[FILTER] Type a regex for that filter",
    ignoreFocusOut: false,
  });
  if (!regexStr) {
    return;
  }

  const isExclude = selected === "Add an exclude filter";
  const randomColor = generateRandomColor(isExclude);
  const color = await pickFilterColor(randomColor);
  if (color === undefined) {
    return;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(regexStr);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    vscode.window.showErrorMessage(`Invalid regex: ${message}`);
    return;
  }

  const id = `${Math.random()}`;
  const filter: Filter = {
    isHighlighted: true,
    isShown: true,
    regex,
    color,
    id,
    iconPath: generateSvgUri(color, true, isExclude),
    count: 0,
    isExclude,
  };
  targetGroup.filters.push(filter);
  refreshEditors(state);
  persistStateForCrossWindowSync(state);
}

export async function editFilterColor(
  treeItem: vscode.TreeItem,
  state: State
): Promise<void> {
  const id = treeItem.id;
  for (const group of state.groups) {
    const filter = group.filters.find((f) => f.id === id);
    if (filter !== undefined) {
      const randomColor = generateRandomColor(filter.isExclude);
      const color = await pickFilterColor(randomColor, filter.color);
      if (color === undefined) {
        return;
      }

      filter.color = color;
      filter.iconPath = generateSvgUri(
        filter.color,
        filter.isHighlighted,
        filter.isExclude
      );
      refreshEditors(state);
      persistStateForCrossWindowSync(state);
      return;
    }
  }
  vscode.window.showErrorMessage("Filter not found.");
}

export function editFilter(treeItem: vscode.TreeItem, state: State) {
  vscode.window
    .showInputBox({
      prompt: "[FILTER] Type a new regex",
      ignoreFocusOut: false,
    })
    .then((regexStr) => {
      if (regexStr === undefined) {
        return;
      }
      const id = treeItem.id;
      let regex: RegExp;
      try {
        regex = new RegExp(regexStr);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        vscode.window.showErrorMessage(`Invalid regex: ${message}`);
        return;
      }
      state.groups.map((group) => {
        const filter = group.filters.find((filter) => filter.id === id);
        if (filter !== undefined) {
          filter.regex = regex;
        }
      });
      refreshEditors(state);
      persistStateForCrossWindowSync(state);
    });
}

export function setHighlight(
  isHighlighted: boolean,
  treeItem: vscode.TreeItem,
  state: State
) {
  const id = treeItem.id;
  const group = state.groups.find((group) => group.id === id);
  if (group !== undefined) {
    group.isHighlighted = isHighlighted;
    group.filters.map((filter) => {
      filter.isHighlighted = isHighlighted;
      filter.iconPath = generateSvgUri(
        filter.color,
        filter.isHighlighted,
        filter.isExclude
      );
    });
  } else {
    state.groups.map((group) => {
      const filter = group.filters.find((filter) => filter.id === id);
      if (filter !== undefined) {
        filter.isHighlighted = isHighlighted;
        filter.iconPath = generateSvgUri(
          filter.color,
          filter.isHighlighted,
          filter.isExclude
        );
      }
    });
  }
  applyHighlight(state, vscode.window.visibleTextEditors);
  refreshEditors(state);
  persistStateForCrossWindowSync(state);
}

//refresh every visible component, including:
//document content of the visible focus mode virtual document,
//decoration of the visible focus mode virtual document,
//highlight decoration of visible editors
//treeview on the side bar
export function refreshEditors(state: State) {
  vscode.window.visibleTextEditors.forEach((editor) => {
    let escapedUri = editor.document.uri.toString();
    if (escapedUri.startsWith("focus:")) {
      state.focusProvider.refresh(editor.document.uri);
      let focusDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: ">>>>>>>focus mode<<<<<<<",
          color: "#888888",
        },
      });
      let focusDecorationRangeArray = [
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
      ];
      editor.setDecorations(focusDecorationType, focusDecorationRangeArray);
    }
  });
  applyHighlight(state, vscode.window.visibleTextEditors);
  console.log("refreshEditors");
  state.filterTreeViewProvider.refresh();
}

export function refreshFilterTreeView(state: State) {
  console.log("refresh only tree view");
  state.filterTreeViewProvider.refresh();
}

export function updateFilterTreeViewAndFocusProvider(state: State) {
  console.log("update filter and tree view");
  state.filterTreeViewProvider.update(state.groups);
  state.focusProvider.update(state.groups);
}

export function updateProjectTreeView(state: State) {
  console.log("update project tree view");
  state.projectTreeViewProvider.update(state.projects);
}

export function addGroup(state: State) {
  vscode.window
    .showInputBox({
      prompt: "[GROUP] Type a new group name",
      ignoreFocusOut: false,
    })
    .then((name) => {
      if (name === undefined) {
        return;
      }
      const group = createGroup(name);
      state.groups.push(group);
      refreshFilterTreeView(state);
      persistStateForCrossWindowSync(state);
    });
}

export function editGroup(treeItem: vscode.TreeItem, state: State) {
  vscode.window
    .showInputBox({
      prompt: "[GROUP] Type a new group name",
      ignoreFocusOut: false,
    })
    .then((name) => {
      if (name === undefined) {
        return;
      }
      const id = treeItem.id;
      const group = state.groups.find((group) => group.id === id);
      group!.name = name;
      refreshFilterTreeView(state);
      persistStateForCrossWindowSync(state);
    });
}

export function deleteGroup(treeItem: vscode.TreeItem, state: State) {
  const deleteIndex = state.groups.findIndex(
    (group) => group.id === treeItem.id
  );
  if (deleteIndex !== -1) {
    state.groups.splice(deleteIndex, 1);
  }
  refreshEditors(state);
  persistStateForCrossWindowSync(state);
}

export function saveProject(state: State) {
  if (state.groups.length === 0) {
    vscode.window.showErrorMessage("There is no filter groups");
    return;
  }

  const selected = state.projects.find((p) => p.selected === true);
  if (selected === undefined) {
    vscode.window.showErrorMessage("There is no selected project");
    return;
  }

  selected.groups = state.groups;
  saveSettings(state.globalStorageUri, state.projects);

  setStatusBarMessage(`Project(${selected.name}) is saved.`);
}

export function addProject(state: State) {
  vscode.window
    .showInputBox({
      prompt: "[PROJECT] Type a new project name",
      ignoreFocusOut: false,
    })
    .then((name) => {
      if (name === undefined) {
        return;
      }

      const project = {
        groups: [],
        name,
        id: `${Math.random()}`,
        selected: false,
      };

      state.projects.push(project);
      saveSettings(state.globalStorageUri, state.projects);
      updateProjectTreeView(state);
    });
}

export function editProject(
  treeItem: vscode.TreeItem,
  state: State,
  callback: () => void
) {
  vscode.window
    .showInputBox({
      prompt: "[PROJECT] Type a new name",
      ignoreFocusOut: false,
    })
    .then((name) => {
      if (name === undefined) {
        return;
      }
      const findIndex = state.projects.findIndex(
        (project) => project.id === treeItem.id
      );
      if (findIndex !== -1) {
        state.projects[findIndex].name = name;
        saveSettings(state.globalStorageUri, state.projects);
        updateProjectTreeView(state);

        callback();
      }
    });
}

export function deleteProject(treeItem: vscode.TreeItem, state: State) {
  const selectedIndex = getProjectSelectedIndex(state.projects);
  const deleteIndex = state.projects.findIndex(
    (project) => project.id === treeItem.id
  );
  if (deleteIndex !== -1) {
    if (deleteIndex === selectedIndex) {
      state.groups = [];
      updateFilterTreeViewAndFocusProvider(state);
      refreshEditors(state);
    }
    state.projects.splice(deleteIndex, 1);
    saveSettings(state.globalStorageUri, state.projects);
    updateProjectTreeView(state);
  }
}

function createDefaultProject(state: State) {
  const name = "NONAME";

  if (state.projects.length === 0 || state.projects[0].name !== name) {
    const project = {
      groups: [],
      name,
      id: `${Math.random()}`,
      selected: false,
    };

    state.projects.unshift(project);
  }
}

export function refreshSettings(state: State) {
  state.projects = readSettings(state.globalStorageUri);
  var selectedIndex = -1;

  // Automatically activate the project if there is only one
  if (state.projects.length === 1) {
    selectedIndex = 0;
  }

  // Add a project named "NONAMED" in the following cases:
  // - A default project is generated for users who do not use the project feature.
  // - If multiple projects are available but none is selected, an empty project is created and selected.
  if (state.projects.length === 0) {
    createDefaultProject(state);
    saveSettings(state.globalStorageUri, state.projects);
    selectedIndex = 0;
  }

  if (selectedIndex === -1) {
    createDefaultProject(state);
    selectedIndex = 0;
  }

  setProjectSelectedFlag(state.projects, selectedIndex);
  state.groups = state.projects[selectedIndex].groups;

  updateProjectTreeView(state);
  updateFilterTreeViewAndFocusProvider(state);
  refreshEditors(state);
}

export function selectProject(
  treeItem: vscode.TreeItem,
  state: State
): boolean {
  const prevSelectedIndex = getProjectSelectedIndex(state.projects);
  const newSelectedIndex = state.projects.findIndex(
    (p) => p.id === treeItem.id
  );
  if (newSelectedIndex !== -1) {
    if (prevSelectedIndex === newSelectedIndex) {
      vscode.window.showInformationMessage("This project is already selected");
      return true;
    }
    state.projects.forEach((p) => {
      p.selected = false;
      p.groups.forEach((g) => {
        g.isHighlighted = false;
        g.isShown = false;
        g.filters.forEach((f) => {
          // f.isHighlighted = false; //TODO: I think this is not needed.
          f.isShown = false;
          f.iconPath = generateSvgUri(f.color, f.isHighlighted, f.isExclude);
        });
      });
    });

    const project = state.projects[newSelectedIndex];
    state.groups = project.groups;
    setProjectSelectedFlag(state.projects, newSelectedIndex);
    updateProjectTreeView(state);
    updateFilterTreeViewAndFocusProvider(state);
    refreshEditors(state);
    return true;
  }
  return false;
}

export function updateExplorerTitle(
  view: vscode.TreeView<vscode.TreeItem>,
  state: State
) {
  const selectedIndex = getProjectSelectedIndex(state.projects);
  if (selectedIndex === -1) {
    view.title = "Filters";
  } else {
    view.title = "Filters (" + state.projects[selectedIndex].name + ")";
  }
}

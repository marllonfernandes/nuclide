'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {
  FileMessageUpdate,
  ObservableDiagnosticUpdater,
} from '../../nuclide-diagnostics-common';
import type {
  FileDiagnosticMessage,
  Trace,
} from '../../nuclide-diagnostics-common/lib/rpc-types';
import type {GetToolBar} from '../../commons-atom/suda-tool-bar';

import invariant from 'assert';
import {Disposable} from 'atom';

import {track} from '../../nuclide-analytics';

import type {HomeFragments} from '../../nuclide-home/lib/types';

import createPackage from '../../commons-atom/createPackage';
import UniversalDisposable from '../../commons-node/UniversalDisposable';
import {observableFromSubscribeFunction} from '../../commons-node/event';
import createDiagnosticsPanel from './createPanel';
import StatusBarTile from './StatusBarTile';
import {applyUpdateToEditor} from './gutter';
import {goToLocation} from '../../commons-atom/go-to-location';
import featureConfig from '../../commons-atom/featureConfig';
import {Observable} from 'rxjs';

const DEFAULT_HIDE_DIAGNOSTICS_PANEL = true;
const DEFAULT_TABLE_HEIGHT = 200;
const DEFAULT_FILTER_BY_ACTIVE_EDITOR = false;
const LINTER_PACKAGE = 'linter';
const MAX_OPEN_ALL_FILES = 20;

type ActivationState = {
  hideDiagnosticsPanel: boolean,
  diagnosticsPanelHeight: number,
  filterByActiveTextEditor: boolean,
};

function disableLinter() {
  atom.packages.disablePackage(LINTER_PACKAGE);
}

class Activation {
  _bottomPanel: ?atom$Panel;
  _consumeUpdatesCalled: boolean;
  _subscriptions: UniversalDisposable;
  _state: ActivationState;
  _statusBarTile: ?StatusBarTile;

  constructor(state_: ?Object): void {
    this._consumeUpdatesCalled = false;
    this._subscriptions = new UniversalDisposable();
    let state = state_;

    // Ensure the integrity of the ActivationState created from state.
    if (!state) {
      state = {};
    }
    if (typeof state.hideDiagnosticsPanel !== 'boolean') {
      state.hideDiagnosticsPanel = DEFAULT_HIDE_DIAGNOSTICS_PANEL;
    }
    if (typeof state.diagnosticsPanelHeight !== 'number') {
      state.diagnosticsPanelHeight = DEFAULT_TABLE_HEIGHT;
    }
    if (typeof state.filterByActiveTextEditor !== 'boolean') {
      state.filterByActiveTextEditor = DEFAULT_FILTER_BY_ACTIVE_EDITOR;
    }
    this._state = state;
  }

  consumeDiagnosticUpdates(diagnosticUpdater: ObservableDiagnosticUpdater): void {
    this._getStatusBarTile().consumeDiagnosticUpdates(diagnosticUpdater);
    this._subscriptions.add(gutterConsumeDiagnosticUpdates(diagnosticUpdater));

    // Currently, the DiagnosticsPanel is designed to work with only one DiagnosticUpdater.
    if (this._consumeUpdatesCalled) {
      return;
    }
    this._consumeUpdatesCalled = true;

    this._tableConsumeDiagnosticUpdates(diagnosticUpdater);
    this._subscriptions.add(addAtomCommands(diagnosticUpdater));
  }

  consumeStatusBar(statusBar: atom$StatusBar): void {
    this._getStatusBarTile().consumeStatusBar(statusBar);
  }

  consumeToolBar(getToolBar: GetToolBar): IDisposable {
    const toolBar = getToolBar('nuclide-diagnostics-ui');
    toolBar.addButton({
      icon: 'law',
      callback: 'nuclide-diagnostics-ui:toggle-table',
      tooltip: 'Toggle Diagnostics Table',
      priority: 100,
    });
    const disposable = new Disposable(() => { toolBar.removeItems(); });
    this._subscriptions.add(disposable);
    return disposable;
  }

  dispose(): void {
    this._subscriptions.dispose();

    if (this._bottomPanel) {
      this._bottomPanel.destroy();
      this._bottomPanel = null;
    }

    if (this._statusBarTile) {
      this._statusBarTile.dispose();
      this._statusBarTile = null;
    }

    this._consumeUpdatesCalled = false;
  }

  serialize(): ActivationState {
    this._tryRecordActivationState(this._state);
    return this._state;
  }

  getHomeFragments(): HomeFragments {
    return {
      feature: {
        title: 'Diagnostics',
        icon: 'law',
        description: 'Displays diagnostics, errors, and lint warnings for your files and projects.',
        command: 'nuclide-diagnostics-ui:show-table',
      },
      priority: 4,
    };
  }

  _tableConsumeDiagnosticUpdates(diagnosticUpdater: ObservableDiagnosticUpdater): void {
    const toggleTable = () => {
      const bottomPanelRef = this._bottomPanel;
      if (bottomPanelRef == null) {
        this._subscriptions.add(this._createPanel(diagnosticUpdater));
      } else if (bottomPanelRef.isVisible()) {
        this._tryRecordActivationState(this._state);
        bottomPanelRef.hide();
      } else {
        logPanelIsDisplayed();
        bottomPanelRef.show();
      }
    };

    const showTable = () => {
      if (this._bottomPanel == null || !this._bottomPanel.isVisible()) {
        toggleTable();
      }
    };

    this._subscriptions.add(
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:toggle-table',
        toggleTable,
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:show-table',
        showTable,
      ),
    );

    if (!this._state.hideDiagnosticsPanel) {
      this._subscriptions.add(this._createPanel(diagnosticUpdater));
    }
  }

  _createPanel(diagnosticUpdater: ObservableDiagnosticUpdater): IDisposable {
    const panel = createDiagnosticsPanel(
      diagnosticUpdater.allMessageUpdates,
      this._state.diagnosticsPanelHeight,
      this._state.filterByActiveTextEditor,
      featureConfig.observeAsStream('nuclide-diagnostics-ui.showDiagnosticTraces'),
      disableLinter,
      filterByActiveTextEditor => {
        if (this._state != null) {
          this._state.filterByActiveTextEditor = filterByActiveTextEditor;
        }
      },
      observeLinterPackageEnabled(),
    );
    logPanelIsDisplayed();
    this._bottomPanel = panel;

    return panel.onDidChangeVisible((visible: boolean) => {
      this._state.hideDiagnosticsPanel = !visible;
    });
  }

  _tryRecordActivationState(): void {
    if (this._bottomPanel && this._bottomPanel.isVisible()) {
      this._state.diagnosticsPanelHeight = this._bottomPanel.getItem().clientHeight;
    }
  }

  _getStatusBarTile(): StatusBarTile {
    if (!this._statusBarTile) {
      this._statusBarTile = new StatusBarTile();
    }
    return this._statusBarTile;
  }

}

function gutterConsumeDiagnosticUpdates(
  diagnosticUpdater: ObservableDiagnosticUpdater,
): IDisposable {
  const fixer = diagnosticUpdater.applyFix.bind(diagnosticUpdater);
  return atom.workspace.observeTextEditors((editor: TextEditor) => {
    const filePath = editor.getPath();
    if (!filePath) {
      return; // The file is likely untitled.
    }

    const callback = (update: FileMessageUpdate) => {
      // Although the subscription below should be cleaned up on editor destroy,
      // the very act of destroying the editor can trigger diagnostic updates.
      // Thus this callback can still be triggered after the editor is destroyed.
      if (!editor.isDestroyed()) {
        applyUpdateToEditor(editor, update, fixer);
      }
    };
    const disposable = new UniversalDisposable(
      diagnosticUpdater.getFileMessageUpdates(filePath).subscribe(callback),
    );

    // Be sure to remove the subscription on the DiagnosticStore once the editor is closed.
    editor.onDidDestroy(() => disposable.dispose());
  });
}

function addAtomCommands(diagnosticUpdater: ObservableDiagnosticUpdater): IDisposable {
  const fixAllInCurrentFile = () => {
    const editor = atom.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }
    const path = editor.getPath();
    if (path == null) {
      return;
    }
    track('diagnostics-autofix-all-in-file');
    diagnosticUpdater.applyFixesForFile(path);
  };

  const openAllFilesWithErrors = () => {
    track('diagnostics-panel-open-all-files-with-errors');
    diagnosticUpdater.allMessageUpdates
      .first()
      .subscribe(messages => {
        if (messages.length > MAX_OPEN_ALL_FILES) {
          atom.notifications.addError(
            `Diagnostics: Will not open more than ${MAX_OPEN_ALL_FILES} files`,
          );
          return;
        }
        for (let index = 0; index < messages.length; index++) {
          const rowData = messages[index];
          if (rowData.scope === 'file' && rowData.filePath != null) {
            const uri = rowData.filePath;
            // If initialLine is N, Atom will navigate to line N+1.
            // Flow sometimes reports a row of -1, so this ensures the line is at least one.
            const line = Math.max(rowData.range ? rowData.range.start.row : 0, 0);
            const column = 0;
            goToLocation(uri, line, column);
          }
        }
      });
  };

  return new UniversalDisposable(
    atom.commands.add(
      'atom-workspace',
      'nuclide-diagnostics-ui:fix-all-in-current-file',
      fixAllInCurrentFile,
    ),
    atom.commands.add(
      'atom-workspace',
      'nuclide-diagnostics-ui:open-all-files-with-errors',
      openAllFilesWithErrors,
    ),
    new KeyboardShortcuts(diagnosticUpdater),
  );
}

// TODO(peterhal): The current index should really live in the DiagnosticStore.
class KeyboardShortcuts {
  _subscriptions: UniversalDisposable;
  _diagnostics: Array<FileDiagnosticMessage>;
  _index: ?number;
  _traceIndex: ?number;

  constructor(diagnosticUpdater: ObservableDiagnosticUpdater) {
    this._index = null;
    this._diagnostics = [];

    this._subscriptions = new UniversalDisposable();

    const first = () => this.setIndex(0);
    const last = () => this.setIndex(this._diagnostics.length - 1);
    this._subscriptions.add(
      diagnosticUpdater.allMessageUpdates.subscribe(
        diagnostics => {
          this._diagnostics = (diagnostics
            .filter(diagnostic => diagnostic.scope === 'file'): any);
          this._index = null;
          this._traceIndex = null;
        }),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-first-diagnostic',
        first,
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-last-diagnostic',
        last,
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-next-diagnostic',
        () => { this._index == null ? first() : this.setIndex(this._index + 1); },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-previous-diagnostic',
        () => { this._index == null ? last() : this.setIndex(this._index - 1); },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-next-diagnostic-trace',
        () => { this.nextTrace(); },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-previous-diagnostic-trace',
        () => { this.previousTrace(); },
      ),
    );
  }

  setIndex(index: number): void {
    this._traceIndex = null;
    if (this._diagnostics.length === 0) {
      this._index = null;
      return;
    }
    this._index = Math.max(0, Math.min(index, this._diagnostics.length - 1));
    this.gotoCurrentIndex();
  }

  gotoCurrentIndex(): void {
    invariant(this._index != null);
    invariant(this._traceIndex == null);
    const diagnostic = this._diagnostics[this._index];
    const range = diagnostic.range;
    if (range == null) {
      goToLocation(diagnostic.filePath);
    } else {
      goToLocation(diagnostic.filePath, range.start.row, range.start.column);
    }
  }

  nextTrace(): void {
    const traces = this.currentTraces();
    if (traces == null) {
      return;
    }
    let candidateTrace = this._traceIndex == null ? 0 : this._traceIndex + 1;
    while (candidateTrace < traces.length) {
      if (this.trySetCurrentTrace(traces, candidateTrace)) {
        return;
      }
      candidateTrace++;
    }
    this._traceIndex = null;
    this.gotoCurrentIndex();
  }

  previousTrace(): void {
    const traces = this.currentTraces();
    if (traces == null) {
      return;
    }
    let candidateTrace = this._traceIndex == null ? traces.length - 1 : this._traceIndex - 1;
    while (candidateTrace >= 0) {
      if (this.trySetCurrentTrace(traces, candidateTrace)) {
        return;
      }
      candidateTrace--;
    }
    this._traceIndex = null;
    this.gotoCurrentIndex();
  }

  currentTraces(): ?Array<Trace> {
    if (this._index == null) {
      return null;
    }
    const diagnostic = this._diagnostics[this._index];
    return diagnostic.trace;
  }

  // TODO: Should filter out traces whose location matches the main diagnostic's location?
  trySetCurrentTrace(traces: Array<Trace>, traceIndex: number): boolean {
    const trace = traces[traceIndex];
    if (trace.filePath != null && trace.range != null) {
      this._traceIndex = traceIndex;
      goToLocation(trace.filePath, trace.range.start.row, trace.range.start.column);
      return true;
    }
    return false;
  }

  dispose(): void {
    this._subscriptions.dispose();
  }
}

function logPanelIsDisplayed() {
  track('diagnostics-show-table');
}

function observeLinterPackageEnabled(): Observable<boolean> {
  return Observable.merge(
    Observable.of(atom.packages.isPackageActive(LINTER_PACKAGE)),
    observableFromSubscribeFunction(atom.packages.onDidActivatePackage.bind(atom.packages))
      .filter(pkg => pkg.name === LINTER_PACKAGE)
      .mapTo(true),
    observableFromSubscribeFunction(atom.packages.onDidDeactivatePackage.bind(atom.packages))
      .filter(pkg => pkg.name === LINTER_PACKAGE)
      .mapTo(false),
  );
}

module.exports = createPackage(Activation);

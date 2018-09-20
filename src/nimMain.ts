/*---------------------------------------------------------
 * Copyright (C) Xored Software Inc. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import fs = require('fs');
import path = require('path');

import { initNimSuggest, closeAllNimSuggestProcesses } from './nimSuggestExec';
import { NimCompletionItemProvider } from './nimSuggest';
import { NimDefinitionProvider } from './nimDeclaration';
import { NimReferenceProvider } from './nimReferences';
import { NimHoverProvider } from './nimHover';
import { NimDocumentSymbolProvider, NimWorkspaceSymbolProvider } from './nimOutline';
import * as indexer from './nimIndexer';
import { NimSignatureHelpProvider } from './nimSignature';
import { NimFormattingProvider } from './nimFormatting';
import { check } from './nimBuild';
import { NIM_MODE } from './nimMode';
import { showHideStatus } from './nimStatus';
import { getDirtyFile } from './nimUtils';

let diagnosticCollection: vscode.DiagnosticCollection;
var fileWatcher: vscode.FileSystemWatcher;
var terminal: vscode.Terminal;

export function activate(ctx: vscode.ExtensionContext): void {
    vscode.commands.registerCommand('nim.run.file', runFile);

    initNimSuggest(ctx);
    ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(NIM_MODE, new NimCompletionItemProvider(), '.', ' '));
    ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(NIM_MODE, new NimDefinitionProvider()));
    ctx.subscriptions.push(vscode.languages.registerReferenceProvider(NIM_MODE, new NimReferenceProvider()));
    ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(NIM_MODE, new NimDocumentSymbolProvider()));
    ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(NIM_MODE, new NimSignatureHelpProvider(), '(', ','));
    ctx.subscriptions.push(vscode.languages.registerHoverProvider(NIM_MODE, new NimHoverProvider()));
    ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(NIM_MODE, new NimFormattingProvider()));
    diagnosticCollection = vscode.languages.createDiagnosticCollection('nim');
    ctx.subscriptions.push(diagnosticCollection);

    vscode.languages.setLanguageConfiguration(NIM_MODE.language as string, {
        indentationRules: {
            increaseIndentPattern: /^\s*((((proc|macro|iterator|template|converter|func)\b.*\=)|(import|var|const|type)\s)|(import|let|var|const|type)|([^:]+:))$/,
            decreaseIndentPattern: /^\s*(((return|break|continue|raise)\n)|((elif|else|except|finally)\b.*:))\s*$/
        },
        wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
        onEnterRules: [{
            beforeText: /^\s*$/,
            action: { indentAction: vscode.IndentAction.None }
        }]
    });

    vscode.window.onDidChangeActiveTextEditor(showHideStatus, null, ctx.subscriptions);

    vscode.window.onDidCloseTerminal((e: vscode.Terminal) => {
        if (terminal && e.processId === terminal.processId) {
            console.log(terminal);
        }
    });

    console.log(ctx.extensionPath);
    indexer.initWorkspace(ctx.extensionPath);
    fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.nim');
    fileWatcher.onDidCreate((uri) => {
        let config = vscode.workspace.getConfiguration('nim');
        if (config.has('licenseString')) {
            let path = uri.fsPath.toLowerCase();
            if (path.endsWith('.nim') || path.endsWith('.nims')) {
                fs.stat(uri.fsPath, (err, stats) => {
                    if (stats && stats.size === 0) {
                        let edit = new vscode.WorkspaceEdit();
                        edit.insert(uri, new vscode.Position(0, 0), config['licenseString']);
                        vscode.workspace.applyEdit(edit);
                    }
                });
            }
        }
        // indexer.addWorkspaceFile(uri.fsPath);
    });

    // fileWatcher.onDidChange(uri => indexer.changeWorkspaceFile(uri.fsPath));
    // fileWatcher.onDidDelete(uri => indexer.removeWorkspaceFile(uri.fsPath));

    ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new NimWorkspaceSymbolProvider()));

    startBuildOnSaveWatcher(ctx.subscriptions);

    if (vscode.window.activeTextEditor) {
        runCheck(vscode.window.activeTextEditor.document);
    }
}

export function deactivate() {
    closeAllNimSuggestProcesses();
    fileWatcher.dispose();
}

function runCheck(document: vscode.TextDocument) {
    let config = vscode.workspace.getConfiguration('nim');

    function mapSeverityToVSCodeSeverity(sev: string) {
        switch (sev) {
            case 'Hint': return vscode.DiagnosticSeverity.Warning;
            case 'Error': return vscode.DiagnosticSeverity.Error;
            case 'Warning': return vscode.DiagnosticSeverity.Warning;
            default: return vscode.DiagnosticSeverity.Error;
        }
    }

    if (document.languageId !== 'nim') {
        return;
    }

    var uri = document.uri;
    check(uri.fsPath, config).then(errors => {
        diagnosticCollection.clear();

        let diagnosticMap: Map<string, vscode.Diagnostic[]> = new Map();
        var err: { [key: string]: boolean; } = {};
        errors.forEach(error => {
            if (!err[error.file + error.line + error.column + error.msg]) {
                let targetUri = error.file;
                let endColumn = error.column;
                if (error.msg.indexOf('\'') >= 0) {
                    endColumn += error.msg.lastIndexOf('\'') - error.msg.indexOf('\'') - 2;
                }
                let line = Math.max(0, error.line - 1);
                let range = new vscode.Range(line, Math.max(0, error.column - 1), line, Math.max(0, endColumn));
                let diagnostic = new vscode.Diagnostic(range, error.msg, mapSeverityToVSCodeSeverity(error.severity));
                let diagnostics = diagnosticMap.get(targetUri);
                if (!diagnostics) {
                    diagnostics = [];
                }
                diagnosticMap.set(targetUri, diagnostics);
                diagnostics.push(diagnostic);
                err[error.file + error.line + error.column + error.msg] = true;
            }
        });

        let entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
        diagnosticMap.forEach((diags, uri) => {
            entries.push([vscode.Uri.file(uri), diags]);
        });
        diagnosticCollection.set(entries);
    }).catch(err => {
        if (err && err.length > 0) {
            vscode.window.showInformationMessage('Error: ' + err);
        }
    });
}

function startBuildOnSaveWatcher(subscriptions: vscode.Disposable[]) {
    vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId !== 'nim') {
            return;
        }
        runCheck(document);
        if (!!vscode.workspace.getConfiguration('nim')['buildOnSave']) {
            vscode.commands.executeCommand('workbench.action.tasks.build');
        }
    }, null, subscriptions);
}

function runFile() {
    let editor = vscode.window.activeTextEditor;
    if (editor) {
        if (!terminal) {
            terminal = vscode.window.createTerminal('Nim');
        }
        terminal.show(true);
        if (editor.document.isUntitled) {
            terminal.sendText('nim ' + vscode.workspace.getConfiguration('nim')['buildCommand'] +
                ' -r "' + getDirtyFile(editor.document) + '"', true);
        } else {
            let outputDirConfig = vscode.workspace.getConfiguration('nim')['runOutputDirectory'];
            var outputParams = '';
            if (!!outputDirConfig) {
                if (vscode.workspace.workspaceFolders) {
                    var rootPath = '';
                    for (const folder of vscode.workspace.workspaceFolders) {
                        if (folder.uri.scheme === 'file') {
                            rootPath = folder.uri.fsPath;
                            break;
                        }
                    }
                    if (rootPath !== '') {
                        if (!fs.existsSync(path.join(rootPath, outputDirConfig))) {
                            fs.mkdirSync(path.join(rootPath, outputDirConfig));
                        }
                        outputParams = ' --out:"' + path.join(outputDirConfig, path.basename(editor.document.fileName, '.nim')) + '"';
                    }
                }
            }
            if (editor && editor.document.isDirty) {
                editor.document.save().then((success: boolean) => {
                    if (editor && success) {
                        terminal.sendText('nim ' + vscode.workspace.getConfiguration('nim')['buildCommand'] +
                            outputParams + ' -r "' + editor.document.fileName + '"', true);
                    }
                });
            } else {
                terminal.sendText('nim ' + vscode.workspace.getConfiguration('nim')['buildCommand'] +
                    outputParams + ' -r "' + editor.document.fileName + '"', true);
            }
        }
    }
}

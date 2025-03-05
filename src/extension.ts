import * as vscode from 'vscode';
import axios from 'axios';

export function activate(context: vscode.ExtensionContext) {
    const provider = new GrokViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('grokInteractive.view', provider)
    );

    vscode.window.showInformationMessage(
        'Grok Interactive updated. Reload VS Code to apply changes?',
        'Reload',
        'Later'
    ).then(selection => {
        if (selection === 'Reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });

    const askGrokDisposable = vscode.commands.registerCommand('grokInteractive.askGrok', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found!');
            return;
        }

        const selection = editor.selection;
        const selectedCode = editor.document.getText(selection);

        if (!selectedCode) {
            vscode.window.showInformationMessage('Please select some code to ask Grok about.');
            return;
        }

        const question = await vscode.window.showInputBox({
            prompt: 'What would you like to ask Grok about this code?',
            placeHolder: 'E.g., "What does this code do?"'
        });

        if (!question) {
            return;
        }

        try {
            const response = await askGrokWithApiCheck(selectedCode, question, [], provider);
            provider.setInitialContent(selectedCode, question, response);
            vscode.commands.executeCommand('grokInteractive.view.focus');
        } catch (error) {
            handleApiError(error);
        }
    });

    const askGrokFullFileDisposable = vscode.commands.registerCommand('grokInteractive.askGrokFullFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found!');
            return;
        }

        const fullFileContent = editor.document.getText();

        if (!fullFileContent) {
            vscode.window.showInformationMessage('The file is empty.');
            return;
        }

        const question = await vscode.window.showInputBox({
            prompt: 'What would you like to ask Grok about the full file?',
            placeHolder: 'E.g., "What does this file do?"'
        });

        if (!question) {
            return;
        }

        try {
            const response = await askGrokWithApiCheck(fullFileContent, question, [], provider);
            provider.setInitialContent(fullFileContent, question, response);
            vscode.commands.executeCommand('grokInteractive.view.focus');
        } catch (error) {
            handleApiError(error);
        }
    });

    const changeApiKeyDisposable = vscode.commands.registerCommand('grokInteractive.changeApiKey', async () => {
        const currentApiKey = vscode.workspace.getConfiguration('grokInteractive').get('apiKey') as string | undefined;
        const newApiKey = await vscode.window.showInputBox({
            prompt: 'Enter your new xAI API key:',
            placeHolder: 'xAI API key',
            value: currentApiKey || '',
            ignoreFocusOut: true
        });

        if (newApiKey) {
            await vscode.workspace.getConfiguration('grokInteractive').update('apiKey', newApiKey, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('API key updated successfully.');
        } else if (newApiKey === '') {
            await vscode.workspace.getConfiguration('grokInteractive').update('apiKey', undefined, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('API key cleared.');
        }
    });

    context.subscriptions.push(askGrokDisposable);
    context.subscriptions.push(askGrokFullFileDisposable);
    context.subscriptions.push(changeApiKeyDisposable);
}

async function askGrokWithApiCheck(code: string, question: string, previousMessages: { role: string; content: string }[], provider: GrokViewProvider): Promise<string> {
    let apiKey = vscode.workspace.getConfiguration('grokInteractive').get('apiKey') as string | undefined;

    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'No xAI API key found. Please enter your API key:',
            placeHolder: 'xAI API key',
            ignoreFocusOut: true
        });

        if (!apiKey) {
            throw new Error('No API key provided. Grok cannot be used without an API key.');
        }

        await vscode.workspace.getConfiguration('grokInteractive').update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('API key saved successfully.');
    }

    const url = 'https://api.x.ai/v1/chat/completions';

    const messages = [
        {
            role: 'system',
            content: 'You are Grok, a helpful AI assistant created by xAI. Answer questions about code concisely and accurately.'
        },
        {
            role: 'user',
            content: `Here is some code:\n\`\`\`\n${code}\n\`\`\`\n${question}`
        },
        ...previousMessages
    ];

    const payload = {
        messages,
        model: 'grok-2-latest',
        stream: false,
        temperature: 0
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        throw error;
    }
}

async function handleApiError(error: any) {
    if (error instanceof Error) {
        if (error.message.includes('API key')) {
            const choice = await vscode.window.showErrorMessage(
                `API error: ${error.message}. Would you like to change the API key?`,
                'Yes',
                'No'
            );
            if (choice === 'Yes') {
                const newApiKey = await vscode.window.showInputBox({
                    prompt: 'Enter a new xAI API key:',
                    placeHolder: 'xAI API key',
                    ignoreFocusOut: true
                });
                if (newApiKey) {
                    await vscode.workspace.getConfiguration('grokInteractive').update('apiKey', newApiKey, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('New API key saved. Please try again.');
                }
            }
        } else {
            vscode.window.showErrorMessage(`Error communicating with Grok: ${error.message}`);
        }
    } else {
        vscode.window.showErrorMessage('Error communicating with Grok: An unknown error occurred');
    }
}

class GrokViewProvider implements vscode.WebviewViewProvider {
    private _webviewView?: vscode.WebviewView;
    private _conversationHistory: { role: string; content: string }[] = [];
    private _initialCode: string = '';

    constructor(private readonly _context: vscode.ExtensionContext) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        this.updateWebview();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.question) {
                try {
                    const response = await askGrokWithApiCheck(this._initialCode, message.question, this._conversationHistory, this);
                    this._conversationHistory.push(
                        { role: 'user', content: message.question },
                        { role: 'assistant', content: response }
                    );
                    this.updateWebview();
                } catch (error) {
                    handleApiError(error);
                }
            } else if (message.command === 'clear') {
                this._conversationHistory = [];
                this._initialCode = '';
                this.updateWebview();
                vscode.window.showInformationMessage('Conversation history cleared.');
            } else if (message.command === 'changeApiKey') {
                vscode.commands.executeCommand('grokInteractive.changeApiKey');
            }
        });
    }

    public setInitialContent(code: string, question: string, response: string) {
        this._initialCode = code;
        this._conversationHistory = [
            { role: 'user', content: `Here is some code:\n\`\`\`\n${code}\n\`\`\`\n${question}` },
            { role: 'assistant', content: response }
        ];
        this.updateWebview();
    }

    private updateWebview() {
        if (!this._webviewView) return;

        this._webviewView.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Grok Response</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family, "Arial, sans-serif");
                        background-color: var(--vscode-editor-background, #1e1e1e);
                        color: var(--vscode-foreground, #d4d4d4);
                        padding: 10px;
                        margin: 0;
                    }
                    .container {
                        width: 100%;
                    }
                    h2 {
                        color: var(--vscode-foreground, #d4d4d4);
                        font-size: 14px;
                        margin: 10px 0 5px;
                    }
                    .message {
                        background: var(--vscode-input-background, #3c3c3c);
                        color: var(--vscode-input-foreground, #d4d4d4);
                        padding: 8px;
                        border-radius: 4px;
                        font-size: 12px;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        max-height: 150px;
                        overflow-y: auto;
                        margin-bottom: 10px;
                        text-align: left;
                        display: flex;
                        align-items: flex-start;
                    }
                    .message strong {
                        margin-right: 5px;
                        flex-shrink: 0;
                    }
                    #input-area {
                        display: flex;
                        margin-top: 10px;
                        gap: 5px;
                    }
                    #question-input {
                        flex-grow: 1;
                        background: var(--vscode-input-background, #3c3c3c);
                        color: var(--vscode-input-foreground, #d4d4d4);
                        border: 1px solid var(--vscode-input-border, #444);
                        padding: 5px;
                        font-size: 12px;
                    }
                    #send-button, #clear-button {
                        background: var(--vscode-button-background, #0e639c);
                        color: var(--vscode-button-foreground, #ffffff);
                        border: none;
                        padding: 5px 10px;
                        cursor: pointer;
                    }
                    #clear-button {
                        background: var(--vscode-button-secondaryBackground, #5f6a79);
                    }
                    #send-button:hover {
                        background: var(--vscode-button-hoverBackground, #1177bb);
                    }
                    #clear-button:hover {
                        background: var(--vscode-button-secondaryHoverBackground, #727e8e);
                    }
                    #confirm-dialog {
                        display: none;
                        position: fixed;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        background: var(--vscode-editor-background, #1e1e1e);
                        border: 1px solid var(--vscode-panel-border, #444);
                        padding: 15px;
                        border-radius: 4px;
                        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
                        z-index: 1000;
                    }
                    #confirm-dialog p {
                        margin: 0 0 10px;
                        color: var(--vscode-foreground, #d4d4d4);
                    }
                    #confirm-dialog button {
                        background: var(--vscode-button-background, #0e639c);
                        color: var(--vscode-button-foreground, #ffffff);
                        border: none;
                        padding: 5px 10px;
                        margin-right: 5px;
                        cursor: pointer;
                    }
                    #confirm-dialog button:hover {
                        background: var(--vscode-button-hoverBackground, #1177bb);
                    }
                    #confirm-cancel {
                        background: var(--vscode-button-secondaryBackground, #5f6a79);
                    }
                    #confirm-cancel:hover {
                        background: var(--vscode-button-secondaryHoverBackground, #727e8e);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div id="conversation">
                        ${this._conversationHistory.length === 0 ? '<p>Select code and use "Ask Grok" to start.</p>' : this._conversationHistory.map(msg => `
                            <div class="message">
                                <strong>${msg.role === 'user' ? 'You:' : 'Grok:'}</strong>${escapeHtml(msg.content)}
                            </div>
                        `).join('')}
                    </div>
                    <div id="input-area">
                        <input type="text" id="question-input" placeholder="Ask Grok something...">
                        <button id="send-button">Send</button>
                        <button id="clear-button">Clear</button>
                    </div>
                    <div id="confirm-dialog">
                        <p>Are you sure you want to clear the conversation history?</p>
                        <button id="confirm-ok">Yes</button>
                        <button id="confirm-cancel">No</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    const sendButton = document.getElementById('send-button');
                    if (sendButton) {
                        sendButton.addEventListener('click', () => {
                            console.log('Send button clicked');
                            const input = document.getElementById('question-input').value;
                            if (input) {
                                vscode.postMessage({ question: input });
                                document.getElementById('question-input').value = '';
                            }
                        });
                    } else {
                        console.error('Send button not found');
                    }

                    const questionInput = document.getElementById('question-input');
                    if (questionInput) {
                        questionInput.addEventListener('keypress', (e) => {
                            if (e.key === 'Enter') {
                                console.log('Enter key pressed');
                                sendButton.click();
                            }
                        });
                    } else {
                        console.error('Question input not found');
                    }

                    const clearButton = document.getElementById('clear-button');
                    const confirmDialog = document.getElementById('confirm-dialog');
                    const confirmOk = document.getElementById('confirm-ok');
                    const confirmCancel = document.getElementById('confirm-cancel');

                    if (clearButton && confirmDialog && confirmOk && confirmCancel) {
                        clearButton.addEventListener('click', () => {
                            console.log('Clear button clicked');
                            confirmDialog.style.display = 'block';
                        });

                        confirmOk.addEventListener('click', () => {
                            console.log('User confirmed clear');
                            vscode.postMessage({ command: 'clear' });
                            confirmDialog.style.display = 'none';
                        });

                        confirmCancel.addEventListener('click', () => {
                            console.log('User canceled clear');
                            confirmDialog.style.display = 'none';
                        });
                    } else {
                        console.error('Clear button or confirm dialog elements not found');
                    }
                </script>
            </body>
            </html>
        `;
    }
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, "\"")
        .replace(/'/g, "'");
}

export function deactivate() {}
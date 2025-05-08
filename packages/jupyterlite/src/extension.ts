import { JupyterFrontEnd, JupyterFrontEndPlugin } from "@jupyterlab/application";
import { showDialog, Dialog } from "@jupyterlab/apputils";
import axios from "axios";

const INTERVAL = 1000;
const TIMEOUT = 15000;

function getPayload(name: string, history_id: string, content: string) {
    return {
        auto_decompress: true,
        files: [],
        history_id: history_id,
        targets: [
            {
                destination: { type: "hdas" },
                elements: [
                    {
                        dbkey: "?",
                        ext: "ipynb",
                        name: `${name}`,
                        paste_content: content,
                        src: "pasted",
                    },
                ],
            },
        ],
    };
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const check = async () => {
            const result = await condition();
            if (result) {
                resolve();
            } else if (Date.now() - start > TIMEOUT) {
                reject(new Error("Timeout waiting for condition"));
            } else {
                setTimeout(check, INTERVAL);
            }
        };
        check();
    });
}

function injectHelpers(app: JupyterFrontEnd) {
    const injected = new Set<string>();
    const tryInject = async (kernelModel: any) => {
        if (kernelModel?.id && !injected.has(kernelModel.id)) {
            const sessions = app.serviceManager.sessions.running();
            const matching = [...sessions].find((s: any) => s.kernel?.id === kernelModel.id);
            if (matching) {
                try {
                    const session = app.serviceManager.sessions.connectTo({ model: matching });
                    if (session.kernel) {
                        const future = session.kernel.requestExecute({
                            code: `def get(dataset_id): return f"Downloading {dataset_id}"\ndef put(dataset_id, content): return f"Uploading to {dataset_id} with content {len(content)} bytes"`,
                        });
                        await future.done;
                        injected.add(kernelModel.id);
                        console.log("✅ Galaxy helpers injected into kernel:", kernelModel.name || kernelModel.id);
                    } else {
                        console.warn("⚠️ No kernel in session for:", kernelModel.id);
                    }
                } catch (err) {
                    console.error("❌ Kernel injection failed:", err);
                }
            } else {
                console.warn("⚠️ No session found for kernel:", kernelModel.id);
            }
        }
    };
    app.serviceManager.kernels.ready.then(() => {
        app.serviceManager.kernels.runningChanged.connect(async (_, kernelModels) => {
            if (Array.isArray(kernelModels)) {
                for (const kernelModel of kernelModels) {
                    await tryInject(kernelModel);
                }
            } else {
                console.warn("⚠️ Expected kernel model array, got:", kernelModels);
            }
        });
    });
}

const plugin: JupyterFrontEndPlugin<void> = {
    id: "jl-galaxy:plugin",
    autoStart: true,
    activate: async (app: JupyterFrontEnd) => {
        console.log("Activating jl-galaxy...", app);
        injectHelpers(app);
        await waitFor(() => !!app.shell && !!app.docRegistry.getWidgetFactory("Notebook"));
        const params = new URLSearchParams(window.location.search);
        const datasetId = params.get("dataset_id");
        const root = params.get("root");
        const datasetUrl = `${root}api/datasets/${datasetId}/display`;

        try {
            const { data: details } = await axios.get(`${root}api/datasets/${datasetId}`);
            const historyId = details.history_id;
            const datasetName = details.name;

            // load notebook
            console.log("📥 Loading notebook from:", datasetUrl);
            try {
                const res = await fetch(datasetUrl);
                if (res.ok) {
                    const nbContent = await res.json();
                    await app.serviceManager.contents.save(datasetName, {
                        type: "notebook",
                        format: "json",
                        content: nbContent,
                    });
                    await app.commands.execute("docmanager:open", {
                        path: datasetName,
                        factory: "Notebook",
                    });
                    console.log("✅ Notebook opened:", datasetName);
                } else {
                    throw new Error(`Failed to fetch notebook: ${res.statusText}`);
                }
            } catch (err) {
                console.error("❌ Could not load dataset notebook:", err);
            }

            // save notebook
            app.commands.commandExecuted.connect((_, args) => {
                if (args.id === "docmanager:save") {
                    console.log("✅ Detected save");
                    const widget = app.shell.currentWidget;
                    const model = (widget as any)?.content?.model;
                    const context = (widget as any)?.context;
                    const actualName = context?.path?.split("/").pop() || "untitled.ipynb";
                    if (model?.toJSON) {
                        showDialog({
                            title: "Save to Galaxy?",
                            body: `Do you want to export "${actualName}" to your Galaxy history?`,
                            buttons: [Dialog.cancelButton(), Dialog.okButton({ label: "Export" })],
                        }).then((result) => {
                            if (result.button.accept) {
                                const content = JSON.stringify(model.toJSON(), null, 2);
                                const payload = getPayload(actualName, historyId, content);
                                axios
                                    .post(`${root}api/tools/fetch`, payload)
                                    .then(() => {
                                        console.log(`✅ Notebook "${actualName}" saved to history`);
                                    })
                                    .catch((err) => {
                                        console.error(`❌ Could not save "${actualName}" to history:`, err);
                                    });
                            } else {
                                console.log("🚫 Export to Galaxy canceled by user");
                            }
                        });
                    }
                }
            });
        } catch (err) {
            console.error("❌ Could not load dataset details:", err);
        }
    },
};

export default [plugin];

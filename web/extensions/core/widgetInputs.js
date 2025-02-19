import { ComfyWidgets, addValueControlWidget } from "../../scripts/widgets.js";
import { app } from "../../scripts/app.js";

const CONVERTED_TYPE = "converted-widget";
const VALID_TYPES = ["STRING", "combo", "number", "BOOLEAN"];
const CONFIG = Symbol();

function getConfig(widgetName) {
	const { nodeData } = this.constructor;
	return nodeData?.input?.required[widgetName] ?? nodeData?.input?.optional?.[widgetName];
}

function isConvertableWidget(widget, config) {
	return (VALID_TYPES.includes(widget.type) || VALID_TYPES.includes(config[0])) && !widget.options?.forceInput;
}

function hideWidget(node, widget, suffix = "") {
	widget.origType = widget.type;
	widget.origComputeSize = widget.computeSize;
	widget.origSerializeValue = widget.serializeValue;
	widget.computeSize = () => [0, -4]; // -4 is due to the gap litegraph adds between widgets automatically
	widget.type = CONVERTED_TYPE + suffix;
	widget.serializeValue = () => {
		// Prevent serializing the widget if we have no input linked
		if (!node.inputs) {
			return undefined;
		}
		let node_input = node.inputs.find((i) => i.widget?.name === widget.name);

		if (!node_input || !node_input.link) {
			return undefined;
		}
		return widget.origSerializeValue ? widget.origSerializeValue() : widget.value;
	};

	// Hide any linked widgets, e.g. seed+seedControl
	if (widget.linkedWidgets) {
		for (const w of widget.linkedWidgets) {
			hideWidget(node, w, ":" + widget.name);
		}
	}
}

function showWidget(widget) {
	widget.type = widget.origType;
	widget.computeSize = widget.origComputeSize;
	widget.serializeValue = widget.origSerializeValue;

	delete widget.origType;
	delete widget.origComputeSize;
	delete widget.origSerializeValue;

	// Hide any linked widgets, e.g. seed+seedControl
	if (widget.linkedWidgets) {
		for (const w of widget.linkedWidgets) {
			showWidget(w);
		}
	}
}

function convertToInput(node, widget, config) {
	hideWidget(node, widget);

	const { type } = getWidgetType(config);

	// Add input and store widget config for creating on primitive node
	const sz = node.size;
	node.addInput(widget.name, type, {
		widget: { name: widget.name, getConfig: () => config },
	});

	for (const widget of node.widgets) {
		widget.last_y += LiteGraph.NODE_SLOT_HEIGHT;
	}

	// Restore original size but grow if needed
	node.setSize([Math.max(sz[0], node.size[0]), Math.max(sz[1], node.size[1])]);
}

function convertToWidget(node, widget) {
	showWidget(widget);
	const sz = node.size;
	node.removeInput(node.inputs.findIndex((i) => i.widget?.name === widget.name));

	for (const widget of node.widgets) {
		widget.last_y -= LiteGraph.NODE_SLOT_HEIGHT;
	}

	// Restore original size but grow if needed
	node.setSize([Math.max(sz[0], node.size[0]), Math.max(sz[1], node.size[1])]);
}

function getWidgetType(config) {
	// Special handling for COMBO so we restrict links based on the entries
	let type = config[0];
	if (type instanceof Array) {
		type = "COMBO";
	}
	return { type };
}

app.registerExtension({
	name: "Comfy.WidgetInputs",
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		// Add menu options to conver to/from widgets
		const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
		nodeType.prototype.getExtraMenuOptions = function (_, options) {
			const r = origGetExtraMenuOptions ? origGetExtraMenuOptions.apply(this, arguments) : undefined;

			if (this.widgets) {
				let toInput = [];
				let toWidget = [];
				for (const w of this.widgets) {
					if (w.options?.forceInput) {
						continue;
					}
					if (w.type === CONVERTED_TYPE) {
						toWidget.push({
							content: `Convert ${w.name} to widget`,
							callback: () => convertToWidget(this, w),
						});
					} else {
						const config = getConfig.call(this, w.name) ?? [w.type, w.options || {}];
						if (isConvertableWidget(w, config)) {
							toInput.push({
								content: `Convert ${w.name} to input`,
								callback: () => convertToInput(this, w, config),
							});
						}
					}
				}
				if (toInput.length) {
					options.push(...toInput, null);
				}

				if (toWidget.length) {
					options.push(...toWidget, null);
				}
			}

			return r;
		};

		nodeType.prototype.onGraphConfigured = function () {
			if (!this.inputs) return;

			for (const input of this.inputs) {
				if (input.widget) {
					if (!input.widget.getConfig) {
						input.widget.getConfig = getConfig.bind(this, input.widget.name);
					}

					// Cleanup old widget config
					if (input.widget.config) {
						if (input.widget.config[0] instanceof Array) {
							// If we are an old converted combo then replace the input type and the stored link data
							input.type = "COMBO";

							const link = app.graph.links[input.link];
							if (link) {
								link.type = input.type;
							}
						}
						delete input.widget.config;
					}

					const w = this.widgets.find((w) => w.name === input.widget.name);
					if (w) {
						hideWidget(this, w);
					} else {
						convertToWidget(this, input);
					}
				}
			}
		};

		const origOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const r = origOnNodeCreated ? origOnNodeCreated.apply(this) : undefined;

			// When node is created, convert any force/default inputs
			if (!app.configuringGraph && this.widgets) {
				for (const w of this.widgets) {
					if (w?.options?.forceInput || w?.options?.defaultInput) {
						const config = getConfig.call(this, w.name) ?? [w.type, w.options || {}];
						convertToInput(this, w, config);
					}
				}
			}

			return r;
		};

		const origOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const r = origOnConfigure ? origOnConfigure.apply(this, arguments) : undefined;
			if (!app.configuringGraph && this.inputs) {
				// On copy + paste of nodes, ensure that widget configs are set up
				for (const input of this.inputs) {
					if (input.widget && !input.widget.getConfig) {
						input.widget.getConfig = getConfig.bind(this, input.widget.name);
					}
				}
			}

			return r;
		};

		function isNodeAtPos(pos) {
			for (const n of app.graph._nodes) {
				if (n.pos[0] === pos[0] && n.pos[1] === pos[1]) {
					return true;
				}
			}
			return false;
		}

		// Double click a widget input to automatically attach a primitive
		const origOnInputDblClick = nodeType.prototype.onInputDblClick;
		const ignoreDblClick = Symbol();
		nodeType.prototype.onInputDblClick = function (slot) {
			const r = origOnInputDblClick ? origOnInputDblClick.apply(this, arguments) : undefined;

			const input = this.inputs[slot];
			if (!input.widget || !input[ignoreDblClick]) {
				// Not a widget input or already handled input
				if (!(input.type in ComfyWidgets) && !(input.widget.getConfig?.()?.[0] instanceof Array)) {
					return r; //also Not a ComfyWidgets input or combo (do nothing)
				}
			}

			// Create a primitive node
			const node = LiteGraph.createNode("PrimitiveNode");
			app.graph.add(node);

			// Calculate a position that wont directly overlap another node
			const pos = [this.pos[0] - node.size[0] - 30, this.pos[1]];
			while (isNodeAtPos(pos)) {
				pos[1] += LiteGraph.NODE_TITLE_HEIGHT;
			}

			node.pos = pos;
			node.connect(0, this, slot);
			node.title = input.name;

			// Prevent adding duplicates due to triple clicking
			input[ignoreDblClick] = true;
			setTimeout(() => {
				delete input[ignoreDblClick];
			}, 300);

			return r;
		};
	},
	registerCustomNodes() {
		class PrimitiveNode {
			constructor() {
				this.addOutput("connect to widget input", "*");
				this.serialize_widgets = true;
				this.isVirtualNode = true;
			}

			applyToGraph() {
				if (!this.outputs[0].links?.length) return;

				function get_links(node) {
					let links = [];
					for (const l of node.outputs[0].links) {
						const linkInfo = app.graph.links[l];
						const n = node.graph.getNodeById(linkInfo.target_id);
						if (n.type == "Reroute") {
							links = links.concat(get_links(n));
						} else {
							links.push(l);
						}
					}
					return links;
				}

				let links = get_links(this);
				// For each output link copy our value over the original widget value
				for (const l of links) {
					const linkInfo = app.graph.links[l];
					const node = this.graph.getNodeById(linkInfo.target_id);
					const input = node.inputs[linkInfo.target_slot];
					const widgetName = input.widget.name;
					if (widgetName) {
						const widget = node.widgets.find((w) => w.name === widgetName);
						if (widget) {
							widget.value = this.widgets[0].value;
							if (widget.callback) {
								widget.callback(widget.value, app.canvas, node, app.canvas.graph_mouse, {});
							}
						}
					}
				}
			}

			refreshComboInNode() {
				const widget = this.widgets?.[0];
				if (widget?.type === "combo") {
					widget.options.values = this.outputs[0].widget.getConfig()[0];

					if (!widget.options.values.includes(widget.value)) {
						widget.value = widget.options.values[0];
						widget.callback(widget.value);
					}
				}
			}

			onAfterGraphConfigured() {
				if (this.outputs[0].links?.length && !this.widgets?.length) {
					this.#onFirstConnection();

					// Populate widget values from config data
					if (this.widgets) {
						for (let i = 0; i < this.widgets_values.length; i++) {
							const w = this.widgets[i];
							if (w) {
								w.value = this.widgets_values[i];
							}
						}
					}

					// Merge values if required
					this.#mergeWidgetConfig();
				}
			}

			onConnectionsChange(_, index, connected) {
				if (app.configuringGraph) {
					// Dont run while the graph is still setting up
					return;
				}

				const links = this.outputs[0].links;
				if (connected) {
					if (links?.length && !this.widgets?.length) {
						this.#onFirstConnection();
					}
				} else {
					// We may have removed a link that caused the constraints to change
					this.#mergeWidgetConfig();

					if (!links?.length) {
						this.#onLastDisconnect();
					}
				}
			}

			onConnectOutput(slot, type, input, target_node, target_slot) {
				// Fires before the link is made allowing us to reject it if it isn't valid

				// No widget, we cant connect
				if (!input.widget) {
					if (!(input.type in ComfyWidgets)) return false;
				}

				if (this.outputs[slot].links?.length) {
					return this.#isValidConnection(input);
				}
			}

			#onFirstConnection(recreating) {
				// First connection can fire before the graph is ready on initial load so random things can be missing
				const linkId = this.outputs[0].links[0];
				const link = this.graph.links[linkId];
				if (!link) return;

				const theirNode = this.graph.getNodeById(link.target_id);
				if (!theirNode || !theirNode.inputs) return;

				const input = theirNode.inputs[link.target_slot];
				if (!input) return;

				let widget;
				if (!input.widget) {
					if (!(input.type in ComfyWidgets)) return;
					widget = { name: input.name, getConfig: () => [input.type, {}] }; //fake widget
				} else {
					widget = input.widget;
				}

				const { type } = getWidgetType(widget.getConfig());
				// Update our output to restrict to the widget type
				this.outputs[0].type = type;
				this.outputs[0].name = type;
				this.outputs[0].widget = widget;

				this.#createWidget(widget[CONFIG] ?? widget.getConfig(), theirNode, widget.name, recreating);
			}

			#createWidget(inputData, node, widgetName, recreating) {
				let type = inputData[0];

				if (type instanceof Array) {
					type = "COMBO";
				}

				let widget;
				if (type in ComfyWidgets) {
					widget = (ComfyWidgets[type](this, "value", inputData, app) || {}).widget;
				} else {
					widget = this.addWidget(type, "value", null, () => {}, {});
				}

				if (node?.widgets && widget) {
					const theirWidget = node.widgets.find((w) => w.name === widgetName);
					if (theirWidget) {
						widget.value = theirWidget.value;
					}
				}

				if (widget.type === "number" || widget.type === "combo") {
					addValueControlWidget(this, widget, "fixed");
				}

				// When our value changes, update other widgets to reflect our changes
				// e.g. so LoadImage shows correct image
				const callback = widget.callback;
				const self = this;
				widget.callback = function () {
					const r = callback ? callback.apply(this, arguments) : undefined;
					self.applyToGraph();
					return r;
				};

				if (!recreating) {
					// Grow our node if required
					const sz = this.computeSize();
					if (this.size[0] < sz[0]) {
						this.size[0] = sz[0];
					}
					if (this.size[1] < sz[1]) {
						this.size[1] = sz[1];
					}

					requestAnimationFrame(() => {
						if (this.onResize) {
							this.onResize(this.size);
						}
					});
				}
			}

			#recreateWidget() {
				const values = this.widgets.map((w) => w.value);
				this.#removeWidgets();
				this.#onFirstConnection(true);
				for (let i = 0; i < this.widgets?.length; i++) this.widgets[i].value = values[i];
			}

			#mergeWidgetConfig() {
				// Merge widget configs if the node has multiple outputs
				const output = this.outputs[0];
				const links = output.links;

				const hasConfig = !!output.widget[CONFIG];
				if (hasConfig) {
					delete output.widget[CONFIG];
				}

				if (links?.length < 2 && hasConfig) {
					// Copy the widget options from the source
					if (links.length) {
						this.#recreateWidget();
					}

					return;
				}

				const config1 = output.widget.getConfig();
				const isNumber = config1[0] === "INT" || config1[0] === "FLOAT";
				if (!isNumber) return;

				for (const linkId of links) {
					const link = app.graph.links[linkId];
					if (!link) continue; // Can be null when removing a node

					const theirNode = app.graph.getNodeById(link.target_id);
					const theirInput = theirNode.inputs[link.target_slot];

					// Call is valid connection so it can merge the configs when validating
					this.#isValidConnection(theirInput, hasConfig);
				}
			}

			#isValidConnection(input, forceUpdate) {
				// Only allow connections where the configs match
				const output = this.outputs[0];
				const config1 = output.widget[CONFIG] ?? output.widget.getConfig();
				const config2 = input.widget.getConfig();

				if (config1[0] instanceof Array) {
					// New input isnt a combo
					if (!(config2[0] instanceof Array)) {
						console.log(`connection rejected: tried to connect combo to ${config2[0]}`);
						return false;
					}
					// New imput combo has a different size
					if (config1[0].length !== config2[0].length) {
						console.log(`connection rejected: combo lists dont match`);
						return false;
					}
					// New input combo has different elements
					if (config1[0].find((v, i) => config2[0][i] !== v)) {
						console.log(`connection rejected: combo lists dont match`);
						return false;
					}
				} else if (config1[0] !== config2[0]) {
					// Types dont match
					console.log(`connection rejected: types dont match`, config1[0], config2[0]);
					return false;
				}

				const keys = new Set([...Object.keys(config1[1] ?? {}), ...Object.keys(config2[1] ?? {})]);

				let customConfig;
				const getCustomConfig = () => {
					if (!customConfig) {
						if (typeof structuredClone === "undefined") {
							customConfig = JSON.parse(JSON.stringify(config1[1] ?? {}));
						} else {
							customConfig = structuredClone(config1[1] ?? {});
						}
					}
					return customConfig;
				};

				const isNumber = config1[0] === "INT" || config1[0] === "FLOAT";
				for (const k of keys.values()) {
					if (k !== "default" && k !== "forceInput" && k !== "defaultInput") {
						let v1 = config1[1][k];
						let v2 = config2[1][k];

						if (v1 === v2 || (!v1 && !v2)) continue;

						if (isNumber) {
							if (k === "min") {
								const theirMax = config2[1]["max"];
								if (theirMax != null && v1 > theirMax) {
									console.log("connection rejected: min > max", v1, theirMax);
									return false;
								}
								getCustomConfig()[k] = v1 == null ? v2 : v2 == null ? v1 : Math.max(v1, v2);
								continue;
							} else if (k === "max") {
								const theirMin = config2[1]["min"];
								if (theirMin != null && v1 < theirMin) {
									console.log("connection rejected: max < min", v1, theirMin);
									return false;
								}
								getCustomConfig()[k] = v1 == null ? v2 : v2 == null ? v1 : Math.min(v1, v2);
								continue;
							} else if (k === "step") {
								let step;
								if (v1 == null) {
									// No current step
									step = v2;
								} else if (v2 == null) {
									// No new step
									step = v1;
								} else {
									if (v1 < v2) {
										// Ensure v1 is larger for the mod
										const a = v2;
										v2 = v1;
										v1 = a;
									}
									if (v1 % v2) {
										console.log("connection rejected: steps not divisible", "current:", v1, "new:", v2);
										return false;
									}

									step = v1;
								}

								getCustomConfig()[k] = step;
								continue;
							}
						}

						console.log(`connection rejected: config ${k} values dont match`, v1, v2);
						return false;
					}
				}

				if (customConfig || forceUpdate) {
					if (customConfig) {
						output.widget[CONFIG] = [config1[0], customConfig];
					}

					this.#recreateWidget();

					const widget = this.widgets[0];
					// When deleting a node this can be null
					if (widget) {
						const min = widget.options.min;
						const max = widget.options.max;
						if (min != null && widget.value < min) widget.value = min;
						if (max != null && widget.value > max) widget.value = max;
						widget.callback(widget.value);
					}
				}

				return true;
			}

			#removeWidgets() {
				if (this.widgets) {
					// Allow widgets to cleanup
					for (const w of this.widgets) {
						if (w.onRemove) {
							w.onRemove();
						}
					}
					this.widgets.length = 0;
				}
			}

			#onLastDisconnect() {
				// We cant remove + re-add the output here as if you drag a link over the same link
				// it removes, then re-adds, causing it to break
				this.outputs[0].type = "*";
				this.outputs[0].name = "connect to widget input";
				delete this.outputs[0].widget;

				this.#removeWidgets();
			}
		}

		LiteGraph.registerNodeType(
			"PrimitiveNode",
			Object.assign(PrimitiveNode, {
				title: "Primitive",
			})
		);
		PrimitiveNode.category = "utils";
	},
});

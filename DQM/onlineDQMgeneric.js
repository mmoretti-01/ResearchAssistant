// -----------------------------------------------------------------------------
// URL helpers
// -----------------------------------------------------------------------------
// These functions read optional query parameters from the page URL.
// Example: ?runNr=123&layoutGroup=Tracking&layout=Mark%20the%20uTP%20expert

        function getRunNumberFromURL() {
            const params = new URLSearchParams(window.location.search);
            const runNr = parseInt(params.get("runNr"));

            return isNaN(runNr) ? 0 : runNr;
        }
        function getLayoutFromURL() {
            const params = new URLSearchParams(window.location.search);
            return params.get("layout") || "";
        }

        function getLayoutGroupFromURL() {
            const params = new URLSearchParams(window.location.search);
            return params.get("layoutGroup") || "";
        }

        function isBuiltinLayout(groupName, layoutName) {
            return !!(
                BUILTIN_LAYOUT_GROUPS[groupName] &&
                Object.prototype.hasOwnProperty.call(BUILTIN_LAYOUT_GROUPS[groupName], layoutName)
            );
        }

// -----------------------------------------------------------------------------
// Global application state
// -----------------------------------------------------------------------------
// autoUpdater manages periodic plot refreshes.
// runNumbers stores the currently selected run.
// activePlots tracks all plots currently displayed on the page.

        window.autoUpdater = new PlotAutoUpdater();
        let runNumbers = [getRunNumberFromURL()];

        const LAYOUT_STORAGE_KEY = "onlineDQM.savedLayouts";

        let activePlots = [];

        let comparisonMode = false;
        let comparisonRunNumbers = [getRunNumberFromURL()];
        let comparisonPlots = [];

// -----------------------------------------------------------------------------
// Built-in layout presets
// -----------------------------------------------------------------------------
// These layouts are always available in the selector.
// Users can load them, but they cannot delete them.
// If a user wants to modify one, they should save it under a new name.

        const LOCAL_LAYOUT_GROUP_NAME = "Local layouts";
        const LAYOUT_SELECTOR_SEPARATOR = "::";

        let BUILTIN_LAYOUT_GROUPS = {};

        const BUILTIN_LAYOUTS_INDEX_FILE = "dqm/layouts.json";

        async function loadBuiltinLayoutsFromFile() {
            try {
                console.log("Trying to load layout index from:", BUILTIN_LAYOUTS_INDEX_FILE);

                const indexResponse = await fetch(BUILTIN_LAYOUTS_INDEX_FILE, {
                    cache: "no-store"
                });

                console.log("Layout index response:", indexResponse.status, indexResponse.url);

                if (!indexResponse.ok) {
                    const text = await indexResponse.text();
                    console.error("Server response was:", text);
                    throw new Error(`Could not load ${BUILTIN_LAYOUTS_INDEX_FILE}: HTTP ${indexResponse.status}`);
                }

                const layoutFiles = await indexResponse.json();

                if (!Array.isArray(layoutFiles)) {
                    throw new Error("Built-in layout index must contain a JSON array.");
                }

                const groups = {};

                for (const entry of layoutFiles) {
                    if (!entry || typeof entry !== "object" || !entry.file) {
                        console.warn("Ignoring invalid layout index entry:", entry);
                        continue;
                    }

                    try {
                        console.log("Trying to load layout file from:", entry.file);

                        const response = await fetch(entry.file, {
                            cache: "no-store"
                        });

                        console.log("Layout file response:", response.status, response.url);

                        if (!response.ok) {
                            const text = await response.text();
                            console.error("Server response was:", text);
                            throw new Error(`Could not load ${entry.file}: HTTP ${response.status}`);
                        }

                        const fileData = await response.json();

                        if (!fileData || typeof fileData !== "object" || Array.isArray(fileData)) {
                            throw new Error("Layout file must contain a JSON object.");
                        }

                        const groupName = fileData.name || entry.name || entry.file;
                        const layouts = fileData.layouts;

                        if (!layouts || typeof layouts !== "object" || Array.isArray(layouts)) {
                            throw new Error("Layout file must contain a 'layouts' object.");
                        }

                        groups[groupName] = {
                            ...(groups[groupName] || {}),
                            ...layouts
                        };
                    } catch (error) {
                        console.error("Could not load layout file:", entry.file, error);
                    }
                }

                BUILTIN_LAYOUT_GROUPS = groups;

                console.log("Loaded built-in layout groups:", BUILTIN_LAYOUT_GROUPS);
            } catch (error) {
                console.error("Could not load built-in layouts:", error);
                BUILTIN_LAYOUT_GROUPS = {};
            }
        }

// -----------------------------------------------------------------------------
// Histogram tree construction
// -----------------------------------------------------------------------------
// Converts a flat list of histogram paths into a nested object.
// Example:
// ["A/B/h1", "A/B/h2", "A/C/h3"]
// becomes:
// {
//   A: {
//     B: { h1: {}, h2: {} },
//     C: { h3: {} }
//   }
// }

        let currentHistogramTree = {};
        function buildHistogramTree(histograms) {
            const root = {};
            for (const hist of histograms) {
                const parts = hist.split("/");
                let node = root;
                for (const part of parts) {
                    if (!node[part])
                        node[part] = {};
                    node = node[part];
                }
            }
            return root;
        }

        function getSortedKeys(node) {
            return Object.keys(node).sort();
        }

        function encodeHistogramPathToIndexPath(histName, tree) {
            const parts = histName.split("/");
            let node = tree;
            const indices = [];

            for (const part of parts) {
                const keys = getSortedKeys(node);
                const index = keys.indexOf(part);

                if (index < 0) {
                    throw new Error(`Histogram path part not found: ${part} in ${histName}`);
                }

                indices.push(index);
                node = node[part];
            }

            return indices.join("_");
        }

        function decodeIndexPathToHistogramPath(indexPath, tree) {
            const indices = indexPath.split("_").map(value => parseInt(value, 10));
            let node = tree;
            const parts = [];

            for (const index of indices) {
                const keys = getSortedKeys(node);

                if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
                    throw new Error(`Invalid histogram index path: ${indexPath}`);
                }

                const key = keys[index];
                parts.push(key);
                node = node[key];
            }

            return parts.join("/");
        }

// -----------------------------------------------------------------------------
// Saved layout storage
// -----------------------------------------------------------------------------
// Layouts are saved in localStorage so they persist between page reloads.
// A saved layout is a list of arrays containing Histogram names and plot configurations.

        function getSavedLayouts() {
            const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);

            if (!raw) {
                return {};
            }

            try {
                return JSON.parse(raw);
            } catch (error) {
                console.error("Could not parse saved layouts:", error);
                return {};
            }
        }

        function setSavedLayouts(layouts) {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
        }

// Combines built-in layout groups with locally saved layouts.
// Local layouts are kept in their own selector group.
        function getAllLayoutGroups() {
            return {
                ...BUILTIN_LAYOUT_GROUPS,
                [LOCAL_LAYOUT_GROUP_NAME]: getSavedLayouts()
            };
        }

        function getLayoutFromGroups(groupName, layoutName) {
            const groups = getAllLayoutGroups();
            const group = groups[groupName];

            if (!group) {
                return null;
            }

            return group[layoutName] || null;
        }

        function getPlotLayoutState(entry) {
            return {
                histName: entry.histName,
                width: entry.wrapper.style.width || `${entry.wrapper.offsetWidth}px`,
                height: entry.wrapper.style.height || `${entry.wrapper.offsetHeight}px`,
                logX: !!entry.plot.param.xAxis.log,
                logY: !!entry.plot.param.yAxis.log,
                logZ: !!entry.plot.param.zAxis.log,
                whiteZeroColor: entry.whiteZeroColor
            };
        }

        function getActivePlotsInDomOrder() {
            const container = document.getElementById("plots_container");
            const wrappers = Array.from(container.children);

            return wrappers
                .map(wrapper => activePlots.find(entry => entry.wrapper === wrapper))
                .filter(Boolean);
        }

// -----------------------------------------------------------------------------
// Layout selector UI
// -----------------------------------------------------------------------------
// Rebuilds the layout dropdown from the current set of saved and built-in layouts.

        function refreshLayoutSelector() {
            const selector = document.getElementById("layoutSelector");

            if (!selector) {
                return;
            }

            const currentValue = selector.value;

            selector.innerHTML = "";

            const placeholder = document.createElement("option");
            placeholder.value = "";
            placeholder.textContent = "Choose layout...";
            selector.appendChild(placeholder);

            const groups = getAllLayoutGroups();

            for (const groupName of Object.keys(groups).sort()) {
                const layouts = groups[groupName];

                if (!layouts || Object.keys(layouts).length === 0) {
                    continue;
                }

                const optgroup = document.createElement("optgroup");
                optgroup.label = groupName;

                for (const layoutName of Object.keys(layouts).sort()) {
                    const option = document.createElement("option");
                    option.value = makeLayoutSelectorValue(groupName, layoutName);
                    option.textContent = layoutName;
                    optgroup.appendChild(option);
                }

                selector.appendChild(optgroup);
            }

            if ([...selector.options].some(option => option.value === currentValue)) {
                selector.value = currentValue;
            }
        }

        function makeLayoutSelectorValue(groupName, layoutName) {
            return `${groupName}${LAYOUT_SELECTOR_SEPARATOR}${layoutName}`;
        }

        function parseLayoutSelectorValue(value) {
            const separatorIndex = value.indexOf(LAYOUT_SELECTOR_SEPARATOR);

            if (separatorIndex < 0) {
                return null;
            }

            return {
                groupName: value.slice(0, separatorIndex),
                layoutName: value.slice(separatorIndex + LAYOUT_SELECTOR_SEPARATOR.length)
            };
        }

// -----------------------------------------------------------------------------
// Plot cleanup
// -----------------------------------------------------------------------------
// Removes all currently displayed plots from the DOM and unregisters them from
// the auto-updater. This is used before loading a saved layout.

        function clearCurrentPlots() {
            clearComparisonDuplicates();

            const plotsToRemove = [...activePlots];

            activePlots = [];

            for (const entry of plotsToRemove) {
                try {
                    if (entry.wrapper && entry.wrapper.parentNode) {
                        entry.wrapper.remove();
                    }
                } catch (error) {
                    console.error("Could not remove plot wrapper:", error, entry);
                }

                try {
                    if (entry.plot) {
                        autoUpdater.removePlot(entry.plot);
                    }
                } catch (error) {
                    console.error("Could not unregister plot from autoUpdater:", error, entry);
                }
            }
        }

// -----------------------------------------------------------------------------
// Layout loading
// -----------------------------------------------------------------------------
// Loads a named layout, clears the current display, and creates one plot for
// each histogram stored in the layout.

        function loadLayout(groupName, layoutName) {
            console.log("Loading layout:", groupName, layoutName);

            const layout = getLayoutFromGroups(groupName, layoutName);

            if (!layout) {
                console.warn("Layout not found:", groupName, layoutName);
                return;
            }

            let plotConfigs;

            if (Array.isArray(layout)) {
                plotConfigs = layout.map(histName => ({
                    histName,
                    width: "500px",
                    height: "460px",
                    logX: false,
                    logY: false,
                    logZ: false
                }));
            }

            else if (layout.histograms && Array.isArray(layout.histograms)) {
                plotConfigs = layout.histograms.map(histName => ({
                    histName,
                    width: "5000px",
                    height: "460px",
                    logX: false,
                    logY: false,
                    logZ: false,
                    whiteZeroColor: layout.whiteZeroColor !== false
                }));
            }

            else if (layout.plots && Array.isArray(layout.plots)) {
                plotConfigs = layout.plots;
            }

            else {
                console.error("Invalid layout format:", layoutName, layout);
                return;
            }

            clearCurrentPlots();

            for (const plotConfig of plotConfigs) {
                console.log("Creating plot for:", plotConfig.histName);
                createNewPlot(plotConfig.histName, plotConfig);
            }
        }


// -----------------------------------------------------------------------------
// Plot creation
// -----------------------------------------------------------------------------
// Creates the DOM wrapper, plot area, close button, and axis controls for a
// single histogram. The plot is then registered with the auto-updater and loaded.


        function createConfiguredPlot(plotDiv, whiteZeroColor) {
            const plot = new MPlotGraph(plotDiv, {
                stats: {
                    show: false
                }
            });

            if (whiteZeroColor) {
                plot.addPlot({
                    zeroColor: "white"
                });
            } else {
                plot.addPlot({});
            }

            return plot;
        }

        function createNewPlot(histName, layoutConfig = {}) {

            const wrapper = document.createElement("div");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.resize = "both";
            wrapper.style.overflow = "auto";
            wrapper.style.height = layoutConfig.height || "460px";
            wrapper.style.width = layoutConfig.width || "500px";
            wrapper.style.border = "1px solid #ccc";
            wrapper.style.margin = "10px";
            wrapper.style.padding = "10px";

            const titleDiv = document.createElement("div");
            titleDiv.textContent = histName;

            const plotDiv = document.createElement("div");
            const controlsDiv = document.createElement("div");

            plotDiv.style.width = `${parseFloat(wrapper.style.width) - 20}px`;
            plotDiv.style.height = `${parseFloat(wrapper.style.height) - 50}px`;
            plotDiv.style.flex = "1";

            const closeBtn = document.createElement("button");
            closeBtn.textContent = "Close";

            const topControls = document.createElement("div");
            topControls.style.display = "flex";
            topControls.style.justifyContent = "space-between";
            topControls.style.alignItems = "center";
            topControls.style.gap = "10px";

            topControls.appendChild(closeBtn);
            topControls.appendChild(controlsDiv);

            wrapper.appendChild(topControls);
            wrapper.appendChild(titleDiv);
            wrapper.appendChild(plotDiv);

            document.getElementById("plots_container").appendChild(wrapper);

            const whiteZeroColor = layoutConfig.whiteZeroColor !== false;
            const plot = createConfiguredPlot(plotDiv, whiteZeroColor);

            if (layoutConfig.logX !== undefined) {
                plot.param.xAxis.log = layoutConfig.logX;
                plot.xMin = layoutConfig.logX ? 0.9 : 0.0;
            }

            if (layoutConfig.logY !== undefined) {
                plot.param.yAxis.log = layoutConfig.logY;
                plot.yMin = layoutConfig.logY ? 0.9 : 0.0;
            }

            if (layoutConfig.logZ !== undefined) {
                plot.param.zAxis.log = layoutConfig.logZ;
                plot.zMin = layoutConfig.logZ ? 0.9 : 0.0;
            }

            makeResizable(plot, wrapper);

            const plotEntry = {
                histName,
                wrapper,
                plotDiv,
                plot,
                whiteZeroColor,
                comparisonDuplicate: null,
                preComparisonSize: null
            };

            closeBtn.onclick = () => {
                removeActivePlotEntry(plotEntry);
            };

            controlsDiv.appendChild(createAxisCheckbox("Log X", "x", plot));
            controlsDiv.appendChild(createAxisCheckbox("Log Y", "y", plot));
            controlsDiv.appendChild(createAxisCheckbox("Log Z", "z", plot));

            plotDiv.style.flex = "1 1 auto";

            plot.param.xAxis.title.textSize /= 2;
            plot.param.yAxis.title.textSize /= 2;

            autoUpdater.addPlot(plot);

            autoUpdater.changeSource(
                plot,
                { name: histName, runs: runNumbers },
                true
            );

            activePlots.push(plotEntry);

            getHistogramMetadata(
                histName,
                runNumbers[0],
                document.getElementById("dqmProg").value
            ).then(metadata => {
                if (metadata.title) titleDiv.textContent = metadata.title;
                if (metadata.axisTitleX) plot.param.xAxis.title.text = metadata.axisTitleX;
                if (metadata.axisTitleY) plot.param.yAxis.title.text = metadata.axisTitleY;
                if (metadata.axisTitleZ) plot.param.zAxis.title.text = metadata.axisTitleZ;

                syncComparisonDuplicateForPlot(plot);
            });

            if (comparisonMode) {
                fitPlotEntryForComparison(plotEntry);
                createComparisonDuplicateForEntry(plotEntry);
            }
        }

// -----------------------------------------------------------------------------
// Comparison plot creation
// -----------------------------------------------------------------------------
// Creates a matching plot in the comparison column for an active plot.
// The duplicate uses the comparison run number but keeps the same histogram,
// axis settings, metadata, and size as the source plot.

        function createComparisonDuplicateForEntry(sourceEntry) {
            const comparisonContainer = document.getElementById("comparison_plots_container");

            if (!comparisonContainer) {
                console.error("Missing #comparison_plots_container in HTML.");
                return;
            }

            if (sourceEntry.comparisonDuplicate) {
                return;
            }

            const duplicateWrapper = document.createElement("div");
            duplicateWrapper.style.display = "flex";
            duplicateWrapper.style.flexDirection = "column";
            duplicateWrapper.style.resize = "both";
            duplicateWrapper.style.overflow = "auto";
            duplicateWrapper.style.height = sourceEntry.wrapper.style.height || `${sourceEntry.wrapper.offsetHeight}px`;
            duplicateWrapper.style.width = sourceEntry.wrapper.style.width || `${sourceEntry.wrapper.offsetWidth}px`;
            duplicateWrapper.style.border = "1px solid #ccc";
            duplicateWrapper.style.margin = "10px";
            duplicateWrapper.style.padding = "10px";

            const COMPARISON_TOP_SHIFT = 20;

            const titleDiv = document.createElement("div");
            titleDiv.textContent = sourceEntry.histName;

            const plotDiv = document.createElement("div");
            plotDiv.style.width = `${parseFloat(duplicateWrapper.style.width) - 20}px`;
            plotDiv.style.height = `${parseFloat(duplicateWrapper.style.height) - 50}px`;
            plotDiv.style.flex = "1 1 auto";

            const shiftedContent = document.createElement("div");
            shiftedContent.style.position = "relative";
            shiftedContent.style.top = `${COMPARISON_TOP_SHIFT}px`;

            shiftedContent.appendChild(titleDiv);
            shiftedContent.appendChild(plotDiv);

            duplicateWrapper.appendChild(shiftedContent);

            comparisonContainer.appendChild(duplicateWrapper);

            const duplicatePlot = createConfiguredPlot(plotDiv, sourceEntry.whiteZeroColor);

            copyPlotSettings(sourceEntry.plot, duplicatePlot);

            makeResizable(duplicatePlot, duplicateWrapper);

            autoUpdater.addPlot(duplicatePlot);

            autoUpdater.changeSource(
                duplicatePlot,
                {
                    name: sourceEntry.histName,
                    runs: comparisonRunNumbers
                },
                true
            );

            getHistogramMetadata(
                sourceEntry.histName,
                comparisonRunNumbers[0],
                document.getElementById("dqmProg").value
            ).then(metadata => {
                if (metadata.title) titleDiv.textContent = metadata.title;
                if (metadata.axisTitleX) duplicatePlot.param.xAxis.title.text = metadata.axisTitleX;
                if (metadata.axisTitleY) duplicatePlot.param.yAxis.title.text = metadata.axisTitleY;
                if (metadata.axisTitleZ) duplicatePlot.param.zAxis.title.text = metadata.axisTitleZ;
            });

            const duplicateEntry = {
                sourceEntry,
                histName: sourceEntry.histName,
                wrapper: duplicateWrapper,
                plotDiv,
                plot: duplicatePlot
            };

            comparisonPlots.push(duplicateEntry);

            sourceEntry.comparisonDuplicate = duplicateEntry;
        }

// -----------------------------------------------------------------------------
// Plot setting synchronization
// -----------------------------------------------------------------------------
// Copies axis scale, axis titles, and minimum values from one plot to another.
// This keeps comparison duplicates visually aligned with their source plots.

        function copyPlotSettings(sourcePlot, targetPlot) {
            targetPlot.param.xAxis.log = !!sourcePlot.param.xAxis.log;
            targetPlot.param.yAxis.log = !!sourcePlot.param.yAxis.log;

            if (sourcePlot.param.zAxis && targetPlot.param.zAxis) {
                targetPlot.param.zAxis.log = !!sourcePlot.param.zAxis.log;
            }

            targetPlot.xMin = sourcePlot.xMin;
            targetPlot.yMin = sourcePlot.yMin;

            if (sourcePlot.zMin !== undefined) {
                targetPlot.zMin = sourcePlot.zMin;
            }

            targetPlot.param.xAxis.title.text = sourcePlot.param.xAxis.title.text;
            targetPlot.param.yAxis.title.text = sourcePlot.param.yAxis.title.text;

            if (sourcePlot.param.zAxis && targetPlot.param.zAxis) {
                targetPlot.param.zAxis.title.text = sourcePlot.param.zAxis.title.text;
            }

            targetPlot.param.xAxis.title.textSize = sourcePlot.param.xAxis.title.textSize;
            targetPlot.param.yAxis.title.textSize = sourcePlot.param.yAxis.title.textSize;
        }

// -----------------------------------------------------------------------------
// Plot removal
// -----------------------------------------------------------------------------
// Removes a main plot and, if present, its comparison duplicate.
// The plot is removed from the DOM, unregistered from the auto-updater,
// and deleted from the active plot list.

    function removeActivePlotEntry(entry) {
        if (entry.comparisonDuplicate) {
            removeComparisonPlotEntry(entry.comparisonDuplicate);
            entry.comparisonDuplicate = null;
        }

        if (entry.wrapper && entry.wrapper.parentNode) {
            entry.wrapper.remove();
        }

        if (entry.plot) {
            autoUpdater.removePlot(entry.plot);
        }

        activePlots = activePlots.filter(activeEntry => activeEntry !== entry);
    }

    function removeComparisonPlotEntry(entry) {
        if (!entry) {
            return;
        }

        if (entry.wrapper && entry.wrapper.parentNode) {
            entry.wrapper.remove();
        }

        if (entry.plot) {
            autoUpdater.removePlot(entry.plot);
        }

        if (entry.sourceEntry && entry.sourceEntry.comparisonDuplicate === entry) {
            entry.sourceEntry.comparisonDuplicate = null;
        }

        comparisonPlots = comparisonPlots.filter(comparisonEntry => comparisonEntry !== entry);
    }

// -----------------------------------------------------------------------------
// Comparison mode controls
// -----------------------------------------------------------------------------
// These handlers enable or disable comparison mode and update the comparison
// run number. When comparison mode is active, each main plot gets a duplicate
// using the selected comparison run.

    window.onComparisonModeChanged = function() {
        console.log("Comparison mode changed");
        const checkbox = document.getElementById("comparisonMode");
        setComparisonMode(checkbox.checked);
    };

    function setComparisonMode(enabled) {
        comparisonMode = enabled;

        const controls = document.getElementById("comparisonControls");
        if (controls) {
            controls.style.display = comparisonMode ? "inline" : "none";
        }

        if (comparisonMode) {
            updateComparisonLayout();
            fitAllActivePlotsForComparison();
            createAllComparisonDuplicates();
        } else {
            clearComparisonDuplicates();
            restoreAllActivePlotSizesAfterComparison();
            updateComparisonLayout();
        }
    }

    function createAllComparisonDuplicates() {
        clearComparisonDuplicates();

        for (const entry of activePlots) {
            createComparisonDuplicateForEntry(entry);
        }
    }

    function clearComparisonDuplicates() {
        const plotsToRemove = [...comparisonPlots];

        for (const entry of plotsToRemove) {
            removeComparisonPlotEntry(entry);
        }

        for (const entry of activePlots) {
            entry.comparisonDuplicate = null;
        }
    }

    window.onComparisonRunChanged = function() {
        const textBox = document.getElementById("comparisonRunNumber");
        const newValue = parseInt(textBox.value);

        if (isNaN(newValue)) {
            textBox.value = comparisonRunNumbers[0];
            return;
        }

        comparisonRunNumbers = [newValue];
        textBox.value = newValue;

        refreshComparisonPlotSources();
    };

    function refreshComparisonPlotSources() {
        for (const entry of comparisonPlots) {
            autoUpdater.changeSource(
                entry.plot,
                {
                    name: entry.histName,
                    runs: comparisonRunNumbers
                },
                true
            );
        }
    }

// -----------------------------------------------------------------------------
// Comparison plot sizing
// -----------------------------------------------------------------------------
// These helpers shrink plots when comparison mode is enabled so that the main
// and comparison columns fit side by side. Original plot sizes are saved and
// restored when comparison mode is disabled.

    function getPx(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resizePlotEntry(entry, width, height) {
    entry.wrapper.style.width = `${width}px`;
    entry.wrapper.style.height = `${height}px`;

    if (entry.plotDiv) {
        entry.plotDiv.style.width = `${Math.max(width - 20, 50)}px`;
        entry.plotDiv.style.height = `${Math.max(height - 50, 50)}px`;
    }

    if (entry.plot && typeof entry.plot.draw === "function") {
        entry.plot.draw();
    }
}

function savePreComparisonSize(entry) {
    if (entry.preComparisonSize) {
        return;
    }

    entry.preComparisonSize = {
        width: entry.wrapper.style.width || `${entry.wrapper.offsetWidth}px`,
        height: entry.wrapper.style.height || `${entry.wrapper.offsetHeight}px`
    };
}

function restorePreComparisonSize(entry) {
    if (!entry.preComparisonSize) {
        return;
    }

    resizePlotEntry(
        entry,
        getPx(entry.preComparisonSize.width, entry.wrapper.offsetWidth),
        getPx(entry.preComparisonSize.height, entry.wrapper.offsetHeight)
    );

    entry.preComparisonSize = null;
}

function fitPlotEntryForComparison(entry) {
    const mainContainer = document.getElementById("plots_container");
    const splitArea = document.getElementById("plots_split_area");

    if (!mainContainer || !splitArea) {
        return;
    }

    savePreComparisonSize(entry);

    const currentWidth = getPx(entry.wrapper.style.width, entry.wrapper.offsetWidth);
    const currentHeight = getPx(entry.wrapper.style.height, entry.wrapper.offsetHeight);

    const availableWidth = mainContainer.clientWidth;

    const horizontalSlack = 40;
    const maxWidth = Math.max(100, availableWidth - horizontalSlack);

    const widthScale = currentWidth > maxWidth ? maxWidth / currentWidth : 1;

    if (widthScale >= 1) {
        return;
    }

    resizePlotEntry(
        entry,
        Math.floor(currentWidth * widthScale),
        currentHeight
    );
}

function fitAllActivePlotsForComparison() {
    for (const entry of activePlots) {
        fitPlotEntryForComparison(entry);
    }
}

function restoreAllActivePlotSizesAfterComparison() {
    for (const entry of activePlots) {
        restorePreComparisonSize(entry);
    }
}


// -----------------------------------------------------------------------------
// Layout actions
// -----------------------------------------------------------------------------
// These functions are called by the layout UI buttons and dropdown.
// They save, load, delete, or share the currently selected layout.

        // Copies a URL for the current run.
        // Only built-in layouts are included in the URL, because saved layouts exist
        // only in the current browser's localStorage.
        // Built-in links store both the layout group and layout name.
        window.copyRunLink = function() {
            const url = new URL(window.location.href);

            url.searchParams.set("runNr", runNumbers[0]);

            const selector = document.getElementById("layoutSelector");
            const selectedLayout = selector ? parseLayoutSelectorValue(selector.value) : null;

            if (
                selectedLayout &&
                isBuiltinLayout(selectedLayout.groupName, selectedLayout.layoutName)
            ) {
                url.searchParams.set("layoutGroup", selectedLayout.groupName);
                url.searchParams.set("layout", selectedLayout.layoutName);
            } else {
                url.searchParams.delete("layoutGroup");
                url.searchParams.delete("layout");
            }

            navigator.clipboard.writeText(url.toString())
                .then(() => {
                    console.log("Copied:", url.toString());
                })
                .catch(err => {
                    console.error("Could not copy link:", err);
                });
        };

        window.saveCurrentLayout = function() {
            const input = document.getElementById("layoutName");
            const layoutName = input.value.trim();

            if (!layoutName) {
                alert("Please enter a layout name.");
                return;
            }

            if (activePlots.length === 0) {
                alert("No histograms are currently open.");
                return;
            }

            const plotsInOrder = getActivePlotsInDomOrder();

            const layout = {
                plots: plotsInOrder.map(getPlotLayoutState)
            };

            const savedLayouts = getSavedLayouts();
            savedLayouts[layoutName] = layout;

            setSavedLayouts(savedLayouts);
            refreshLayoutSelector();

            document.getElementById("layoutSelector").value = makeLayoutSelectorValue(LOCAL_LAYOUT_GROUP_NAME, layoutName);

            console.log("Saved layout:", layoutName, layout);
        };

        window.onLayoutSelected = function() {
            const selector = document.getElementById("layoutSelector");
            const selectedLayout = parseLayoutSelectorValue(selector.value);

            console.log("Selected layout:", selectedLayout);

            if (!selectedLayout) {
                return;
            }

            loadLayout(selectedLayout.groupName, selectedLayout.layoutName);
        };

        window.deleteSelectedLayout = function() {
            const selector = document.getElementById("layoutSelector");
            const selectedLayout = parseLayoutSelectorValue(selector.value);

            if (!selectedLayout) {
                alert("Please select a layout to delete.");
                return;
            }

            if (selectedLayout.groupName !== LOCAL_LAYOUT_GROUP_NAME) {
                alert("Built-in layouts cannot be deleted.");
                return;
            }

            const savedLayouts = getSavedLayouts();

            if (!savedLayouts[selectedLayout.layoutName]) {
                alert("Saved layout not found.");
                return;
            }

            delete savedLayouts[selectedLayout.layoutName];

            setSavedLayouts(savedLayouts);
            refreshLayoutSelector();

            console.log("Deleted layout:", selectedLayout.layoutName);
        };

        function createAxisCheckbox(labelText, axis, plot) {
            const label = document.createElement("label");
            label.style.marginRight = "10px";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";

            if (axis === "x") {
                checkbox.checked = !!plot.param.xAxis.log;
            } else if (axis === "y") {
                checkbox.checked = !!plot.param.yAxis.log;
            } else if (axis === "z") {
                checkbox.checked = !!plot.param.zAxis.log;
            }

            checkbox.onchange = () => {
                if (axis === "x") {
                    plot.param.xAxis.log = checkbox.checked;
                    plot.xMin = checkbox.checked ? 0.9 : 0.0;
                } else if (axis === "y") {
                    plot.param.yAxis.log = checkbox.checked;
                    plot.yMin = checkbox.checked ? 0.9 : 0.0;
                } else if (axis === "z") {
                    plot.param.zAxis.log = checkbox.checked;
                    plot.zMin = checkbox.checked ? 0.9 : 0.0;
                }

                plot.draw();
                syncComparisonDuplicateForPlot(plot);
            };

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(" " + labelText));

            return label;
        }

// -----------------------------------------------------------------------------
// Comparison plot synchronization
// -----------------------------------------------------------------------------
// Updates an existing comparison duplicate after the source plot changes.
// This is used when axis options are toggled on the main plot.

        function syncComparisonDuplicateForPlot(sourcePlot) {
            const sourceEntry = activePlots.find(entry => entry.plot === sourcePlot);

            if (!sourceEntry || !sourceEntry.comparisonDuplicate) {
                return;
            }

            const duplicatePlot = sourceEntry.comparisonDuplicate.plot;

            copyPlotSettings(sourcePlot, duplicatePlot);
            duplicatePlot.draw();
        }

// -----------------------------------------------------------------------------
// Comparison layout
// -----------------------------------------------------------------------------
// Updates the plot containers so normal mode uses one column and comparison
// mode uses two side-by-side columns.

        function updateComparisonLayout() {
            const splitArea = document.getElementById("plots_split_area");
            const mainContainer = document.getElementById("plots_container");
            const comparisonContainer = document.getElementById("comparison_plots_container");

            if (!splitArea || !mainContainer || !comparisonContainer) {
                console.error("Missing comparison layout elements.");
                return;
            }

            splitArea.style.display = "flex";
            splitArea.style.gap = "16px";
            splitArea.style.width = "100%";

            mainContainer.style.minWidth = "0";

            comparisonContainer.style.minWidth = "0";

            if (comparisonMode) {
                mainContainer.style.flex = "1";
                comparisonContainer.style.flex = "1";
                comparisonContainer.style.display = "block";
            } else {
                mainContainer.style.flex = "1";
                comparisonContainer.style.display = "none";
            }
        }

// -----------------------------------------------------------------------------
// Histogram tree rendering
// -----------------------------------------------------------------------------
// Renders the nested histogram object as a collapsible tree.
// Folder-like nodes expand/collapse.
// Leaf nodes create a new plot when clicked.

        function renderHistogramTree(node, parent, path = "") {
            const ul = document.createElement("ul");

            for (const key of getSortedKeys(node)) {
                const li = document.createElement("li");
                const fullPath = path ? path + "/" + key : key;

                const children = node[key];
                const hasChildren = Object.keys(children).length > 0;

                li.textContent = key;

                if (hasChildren) {
                    li.style.cursor = "pointer";

                    const childUL = renderHistogramTree(children, li, fullPath);
                    childUL.style.display = "none";

                    li.onclick = (e) => {
                        e.stopPropagation();
                        childUL.style.display =
                            childUL.style.display === "none" ? "block" : "none";
                    };
                } else {
                    li.onclick = (e) => {
                        e.stopPropagation();
                        onHistogramSelectedFromTree(fullPath);
                    };
                }

                ul.appendChild(li);
            }

            parent.appendChild(ul);
            return ul;
        }

        function onHistogramSelectedFromTree(histName) {
            createNewPlot(histName);
            closeHistogramPopup();
        }

// -----------------------------------------------------------------------------
// Page initialization
// -----------------------------------------------------------------------------
// Initializes MIDAS components, restores the run number from the URL,
// loads the histogram tree, refreshes the layout selector, and optionally
// loads a built-in layout from the URL.

        window.pageInit = async function() {
            mhttpd_init('Generic');
            //mplot_init();

            document.getElementById("runNumbers").value = runNumbers[0];

            updateComparisonLayout();

            await loadBuiltinLayoutsFromFile();

            updateHistogramSelectors();
            refreshLayoutSelector();

            const layoutGroupName = getLayoutGroupFromURL();
            const layoutName = getLayoutFromURL();

            if (layoutGroupName && layoutName) {
                if (isBuiltinLayout(layoutGroupName, layoutName)) {
                    document.getElementById("layoutSelector").value =
                        makeLayoutSelectorValue(layoutGroupName, layoutName);

                    loadLayout(layoutGroupName, layoutName);
                } else {
                    console.warn("Ignoring non-built-in layout from URL:", layoutGroupName, layoutName);
                }
            }
        };


// -----------------------------------------------------------------------------
// Refresh, run, and DQM controls
// -----------------------------------------------------------------------------
// These handlers control auto-refresh, manual run changes, DQM program changes,
// histogram list updates, and clearing histograms.

        window.onAutoRefreshClicked = function() {
            const isEnabled = document.getElementById('autoRefresh').checked;
            if(isEnabled) {
                document.getElementById('refresh').disabled = true;
                autoUpdater.start(2000);
            }
            else {
                document.getElementById('refresh').disabled = false;
                autoUpdater.updateInterval = 0;
            }
        }
        
        function refreshActivePlotSources() {
            for (const entry of activePlots) {
                autoUpdater.changeSource(
                    entry.plot,
                    {
                        name: entry.histName,
                        runs: runNumbers
                    },
                    true
                );
            }
        }

        window.onChangeRun = function() {
            let textBox = document.getElementById("runNumbers");
            let newValue = parseInt(textBox.value);

            if (isNaN(newValue)) {
                textBox.value = runNumbers[0];
            } else {
                runNumbers = [newValue];
                textBox.value = newValue;

                const url = new URL(window.location.href);
                url.searchParams.set("runNr", newValue);
                window.history.replaceState({}, "", url);

                refreshActivePlotSources();
                updateHistogramSelectors();
            }
        }

        window.onDQMProgChanged = function() {
            let selector = document.getElementById("dqmProg");
            autoUpdater.setDefaultDQMProg(selector.value);
            updateHistogramSelectors();
        }

        window.updateHistogramSelectors = function() {
            listHistograms(runNumbers, document.getElementById("dqmProg").value).then((histograms) => {
                const container = document.getElementById("histogramTree");

                if (!container)
                    return;

                container.innerHTML = "";

                currentHistogramTree = buildHistogramTree(histograms);

                renderHistogramTree(currentHistogramTree, container);

            }).catch((error) => {
                console.log(error);
            });
        }

        window.onClearAll = function() {
            clearHistograms().then(
                (unusedResult) => {
                    // Perform a refresh to plot the empty histogram (and any data created since the refresh returned).
                    autoUpdater.refreshAll();
                }
            );
        }

        window.openHistogramPopup = function() {
            const popup = document.getElementById("histogramPopup");
            popup.style.display = "block";
        }

        window.closeHistogramPopup = function() {
            const popup = document.getElementById("histogramPopup");
            popup.style.display = "none";
        }

        window.copyEncodedLayout = function() {
            try {
                if (!currentHistogramTree || Object.keys(currentHistogramTree).length === 0) {
                    alert("Histogram tree is not loaded yet.");
                    return;
                }

                const plotsInOrder = getActivePlotsInDomOrder();

                if (plotsInOrder.length === 0) {
                    alert("No histograms are currently open.");
                    return;
                }

                const encodedPlots = plotsInOrder.map(entry => {
                    const indexPath = encodeHistogramPathToIndexPath(entry.histName, currentHistogramTree);

                    const width = Math.round(getPx(
                        entry.wrapper.style.width,
                        entry.wrapper.offsetWidth
                    ));

                    const height = Math.round(getPx(
                        entry.wrapper.style.height,
                        entry.wrapper.offsetHeight
                    ));

                    return `${indexPath}:${width}_${height}`;
                });

                const encodedLayout = `${runNumbers[0]}/${encodedPlots.join(",")}`;

                navigator.clipboard.writeText(encodedLayout)
                    .then(() => {
                        console.log("Copied encoded layout:", encodedLayout);
                    })
                    .catch(error => {
                        console.error("Could not copy encoded layout:", error);
                        alert("Could not copy layout to clipboard.");
                    });

            } catch (error) {
                console.error("Could not encode layout:", error);
                alert("Could not encode layout. See console for details.");
            }
        };

        window.importEncodedLayout = async function() {
            try {
                if (!currentHistogramTree || Object.keys(currentHistogramTree).length === 0) {
                    alert("Histogram tree is not loaded yet.");
                    return;
                }

                const text = await navigator.clipboard.readText();

                const firstSlash = text.indexOf("/");

                if (firstSlash < 0) {
                    throw new Error("Invalid layout string. Missing '/'.");
                }

                const runPart = text.slice(0, firstSlash);
                const plotsPart = text.slice(firstSlash + 1);

                const importedRun = parseInt(runPart, 10);

                if (!Number.isInteger(importedRun)) {
                    throw new Error(`Invalid run number: ${runPart}`);
                }

                const plotSpecs = plotsPart
                    .split(",")
                    .map(part => part.trim())
                    .filter(Boolean);

                if (plotSpecs.length === 0) {
                    throw new Error("No plots found in layout string.");
                }

                runNumbers = [importedRun];
                document.getElementById("runNumbers").value = importedRun;

                const url = new URL(window.location.href);
                url.searchParams.set("runNr", importedRun);
                window.history.replaceState({}, "", url);

                clearCurrentPlots();

                for (const spec of plotSpecs) {
                    const [indexPath, sizePart] = spec.split(":");

                    if (!indexPath || !sizePart) {
                        throw new Error(`Invalid plot spec: ${spec}`);
                    }

                    const histName = decodeIndexPathToHistogramPath(indexPath, currentHistogramTree);

                    const [width, height] = sizePart
                        .split("_")
                        .map(value => parseInt(value, 10));

                    if (!Number.isInteger(width) || !Number.isInteger(height)) {
                        throw new Error(`Invalid plot size: ${sizePart}`);
                    }

                    createNewPlot(histName, {
                        width: `${width}px`,
                        height: `${height}px`,
                        logX: false,
                        logY: false,
                        logZ: false
                    });
                }

                console.log("Imported encoded layout:", text);

            } catch (error) {
                console.error("Could not import encoded layout:", error);
                alert("Could not import layout from clipboard. See console for details.");
            }
        };

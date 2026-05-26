/** Decodes a histogram encoded in binary as an arraybuffer. */
function decodeHistogram(arraybuffer) {
    let alignTo = function(byteIndex, alignment) {
        let remainder = byteIndex % alignment;
        if(remainder == 0) return byteIndex; // Already at the requested alignment
        else return byteIndex + (alignment - remainder); // Add on the amount required to align properly
    }

    let dataView = new DataView(arraybuffer);

    const little_endian = true;
    let currentByte = 0;
    let version = dataView.getUint8(currentByte++, little_endian);

    if(version != 1) throw new Error("Don't know how to decode a histogram with version " + version);

    let histogram = {};

    // histogramType is the index into the C++ mu3e::dqm::PlotCollection::object_type variant. There's
    // quite a lot of redundant information in the format (dimensions and type sizes) but this is the
    // only place where it says if the bin content is an integer or floating point type.
    // Possible values are:
    //  * 0: Histogram1DF - 1D 32 bit float histogram
    //  * 1: Histogram1DD - 1D 64 bit float histogram
    //  * 2: Histogram2DF - 2D 32 bit float histogram
    //  * 3: Histogram1DI - 1D 32 bit unsigned int histogram
    //  * 4: Histogram2DI - 2D 32 bit unsigned int histogram
    //  * 5: RollingHistogram2DF - this is the same as Histogram2DF by the time it gets here
    //  * 6: Histogram2DD - 2D 64 bit float histogram
    let histogramType = dataView.getUint8(currentByte++, little_endian);
    const isIntegerType = (histogramType == 3 || histogramType == 4);
    let dimensions = dataView.getUint8(currentByte++, little_endian);

    let abscissaSizes = [];
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        abscissaSizes[dimension] = dataView.getUint8(currentByte++, little_endian);
    }

    let ordinateSize = dataView.getUint8(currentByte++, little_endian);

    currentByte = alignTo(currentByte, 4); // bin sizes are Uint32 and aligned on that boundary

    histogram.numberOfBins = [];
    let totalBins = 1;
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        histogram.numberOfBins[dimension] = dataView.getUint32(currentByte, little_endian);
        currentByte += 4;
        totalBins *= (histogram.numberOfBins[dimension] + 2); // `+2` for under and overflow bins
    }

    // It's easier to read a datatype given its size rather than use the function name
    let readFloat = function(size, offset, endianness) {
        if(size == 4) return dataView.getFloat32(offset, endianness)
        else if(size == 8) return dataView.getFloat64(offset, endianness)
        else throw new Error("Can't decode histogram because a float of size " + size + " was requested.");
    }

    histogram.lowEdge = []
    histogram.highEdge = []
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        let size = abscissaSizes[dimension];
        currentByte = alignTo(currentByte, size);
        histogram.lowEdge[dimension] = readFloat(size, currentByte, little_endian);
        currentByte += size;
        histogram.highEdge[dimension] = readFloat(size, currentByte, little_endian);
        currentByte += size;
    }

    currentByte = alignTo(currentByte, 8); // entries is a Uint64 and aligned on that boundary
    histogram.entries = dataView.getBigUint64(currentByte, little_endian);
    currentByte += 8;

    currentByte = alignTo(currentByte, ordinateSize); // data will be aligned to its size
    if(ordinateSize == 4 && !isIntegerType) histogram.data = new Float32Array(arraybuffer, currentByte, totalBins);
    else if(ordinateSize == 4 && isIntegerType) histogram.data = new Uint32Array(arraybuffer, currentByte, totalBins);
    else if(ordinateSize == 8) histogram.data = new Float64Array(arraybuffer, currentByte, totalBins);
    else throw new Error("Don't know how to decode a histogram with ordinate size " + ordinateSize);

    return histogram;
}

function decodeHistogramMetadata(arraybuffer) {
    let dataView = new DataView(arraybuffer);

    if(arraybuffer.byteLength == 0) return;

    const little_endian = true;
    let currentByte = 0;

    //
    // The first byte says how many entries there are.
    //
    const entries = dataView.getUint8(currentByte++, little_endian);

    let textDecoder = new TextDecoder();
    let returnValue = {};

    for(let entryIndex = 0; entryIndex < entries; ++entryIndex) {
        //
        // For each entry there will be 1 byte to describe the metadata "category", then a null terminated
        // string for the value. The available categories are the C++ mu3e::dqm::Metadata::Category enum values
        // (see tools/include/mu3e/dqm/Metadata.hpp). They are:
        // * 0 - Category::Title
        // * 1 - Category::Description
        // * 2 - Category::AxisTitleX
        // * 3 - Category::AxisTitleY
        // * 4 - Category::AxisTitleZ
        //
        const entryType = dataView.getUint8(currentByte++, little_endian);

        const entryStart = currentByte;
        // Look for the null terminator to see how long the string is.
        for(; currentByte < arraybuffer.byteLength; ++currentByte) {
            if(dataView.getUint8(currentByte) == 0) break;
        }

        let text = textDecoder.decode(arraybuffer.slice(entryStart, currentByte));
        ++currentByte; // skip over the null terminator

        if(entryType == 0) returnValue.title = text;
        else if(entryType == 1) returnValue.description = text;
        else if(entryType == 2) returnValue.axisTitleX = text;
        else if(entryType == 3) returnValue.axisTitleY = text;
        else if(entryType == 4) returnValue.axisTitleZ = text;
    }

    return returnValue;
}

/** For internal use. Makes an RPC request and if the result was truncated by Midas make another request with the correct max_reply_length.
 *
 * This assumes that the response has an 8 byte header saying the actual message size and the type of the message (as all DQM responses do). */
function dqmRemoteCall(cmd, args, expectedMessageType, dqmProgname, max_reply_length) {
    return mjsonrpc_call("brpc", { "client_name": dqmProgname, "max_reply_length": max_reply_length, "cmd": cmd, "args": args}, "arraybuffer").then(
        function(rpc) {
            if(rpc.byteLength == 0) throw new Error("Empty response");

            // The first 8 bytes are a protocol header. It's 4 bytes of little endian message size, followed by 4
            // bytes describing the message type.
            // Use this to check that Midas hasn't truncated the message. If it has, repeat the call with an increased
            // `max_reply_length` parameter.
            let dataView = new DataView(rpc);
            let expectedMessageLength = dataView.getUint32(0, true /*little endian*/);
            let messageType = dataView.getUint32(4); // Note that we read as big endian here. It's a 4 byte sequence we're reading, and order matters.
            if(messageType != expectedMessageType) console.log("dqmRemoteCall() Warning: Unexpected message type '" + messageType + "'");

            if(rpc.byteLength < expectedMessageLength) {
                console.log("dqmRemoteCall() RPC call of size " + expectedMessageLength + " was truncated. Trying again with adequate \"max_reply_length\".");
                return mjsonrpc_call("brpc", { "client_name": dqmProgname, "max_reply_length": expectedMessageLength, "cmd": cmd, "args": args }, "arraybuffer").then(
                    (rpc) => {
                        if(rpc.byteLength == 0) throw new Error("Empty response");
                        let dataView = new DataView(rpc);
                        let expectedMessageLength = dataView.getUint32(0, true /*little endian*/);
                        let messageType = dataView.getUint32(4); // Note that we read as big endian here. It's a 4 byte sequence we're reading, and order matters.
                        if(messageType != expectedMessageType) console.log("dqmRemoteCall() Warning: Unexpected message type '" + messageType + "'");

                        if(rpc.byteLength < expectedMessageLength) throw new Error("Couldn't get full histogram data after second attempt");
                        else return rpc.slice(8);
                    }
                );
            }

            return rpc.slice(8);
        }
    );
}

/** Asynchronously retrieves a histogram object from a DQM instance.
 *
 * The `runs` argument is an array of the run numbers that you want the histogram for, where `0` is
 * the current run. The default is `[0]` i.e. only the current run. */
function getHistogram(name, runs = [0], dqmProgname = "ana") {
    const messageType_hist = 0x68697374; // equivalent to the 4 byte sequence "hist".
    const initial_max_reply_length = 1048576;

    return dqmRemoteCall("dqm::histogram", JSON.stringify({name: name, runs: runs}), messageType_hist, dqmProgname, initial_max_reply_length).then(
        (response) => {
            return decodeHistogram(response);
        }
    );
}

function getHistogramMetadata(name, run = 0, dqmProgname = "ana") {
    const messageType_meta = 0x6d657461; // equivalent to the 4 byte sequence "meta".
    const initial_max_reply_length = 1024;

    return dqmRemoteCall("dqm::metadata", JSON.stringify({name: name, runs: [run]}), messageType_meta, dqmProgname, initial_max_reply_length).then(
        (response) => {
            return decodeHistogramMetadata(response);
        }
    );
}

/** Displays the provided histogram in the Midas MPlotGraph instance */
function displayHistogram(histogram, mPlotGraph, seriesIndex = 0) {
    try {
        mPlotGraph.error = null; // clear in case it was set before

        // The binning details we have don't include under/overflow, but Midas histograms don't add them implicitly.
        // So we have to manually add bins for the under and overflow bins.
        let binWidths = []
        const dimensions = histogram.numberOfBins.length
        for(let dimension = 0; dimension < dimensions; ++dimension) {
            binWidths[dimension] = (histogram.highEdge[dimension] - histogram.lowEdge[dimension]) / histogram.numberOfBins[dimension];
        }

        // If the param.plot array is not big enough, get Midas to embiggen it.
        while(mPlotGraph.param.plot.length <= seriesIndex) {
            mPlotGraph.addPlot();
        }

        let xdata, ydata, zdata;
        if(dimensions == 1) {
            mPlotGraph.param.plot[seriesIndex].type = "histogram";
            mPlotGraph.param.plot[seriesIndex].xMin = histogram.lowEdge[0] - binWidths[0]; // add a bin for the underflow
            mPlotGraph.param.plot[seriesIndex].xMax = histogram.highEdge[0] + binWidths[0]; // add a bin for the overflow
            mPlotGraph.param.plot[seriesIndex].xData = undefined; // Force Midas to recompute the axis data
            ydata = histogram.data;
        }
        else if(dimensions == 2) {
            // Pretty sure seriesIndex != 0 won't work for 2D plots, but we'll honour the users request.
            mPlotGraph.param.plot[seriesIndex].type = "colormap";
            mPlotGraph.param.plot[seriesIndex].showZScale = true;
            mPlotGraph.param.plot[seriesIndex].nx = histogram.numberOfBins[0] + 2; // `+2` for under and overflow
            mPlotGraph.param.plot[seriesIndex].ny = histogram.numberOfBins[1] + 2;
            mPlotGraph.param.plot[seriesIndex].xMin = histogram.lowEdge[0] - binWidths[0]; // add a bin for the underflow
            mPlotGraph.param.plot[seriesIndex].xMax = histogram.highEdge[0] + binWidths[0]; // add a bin for the overflow
            mPlotGraph.param.plot[seriesIndex].yMin = histogram.lowEdge[1] - binWidths[1];
            mPlotGraph.param.plot[seriesIndex].yMax = histogram.highEdge[1] + binWidths[1];
            zdata = histogram.data;
        }

        mPlotGraph.setData(seriesIndex, xdata, ydata, zdata);
    } catch(error) {
        console.log("error with `displayHistogram()`: ", error, "histogram was:", histogram);
        mPlotGraph.error = error;
        mPlotGraph.redraw();
    }
}

function listHistograms(runs = [0], dqmProgname = "ana") {
    const messageType_list = 0x6C697374; // equivalent to the 4 byte sequence "list".
    const initial_max_reply_length = 2097152;

    return dqmRemoteCall("dqm::list", JSON.stringify({runs: runs}), messageType_list, dqmProgname, initial_max_reply_length).then(
        (response) => {
            if(response.byteLength == 0) return []; // Otherwise the split below would return `[""]` rather than an empty array.

            let textDecoder = new TextDecoder(); // Default is utf8
            return textDecoder.decode(response).split("\n"); // Convert text, then split into an array on newlines
        }
    );
}

/** @brief Clear either all histograms, all histograms in a collection, or a specific histogram.
 *
 * If a histogram name is specified, clears only that histogram. If only the collection is specified
 * clears all histograms in that collection. If nothing is specified clears all histograms.
 */
function clearHistograms(histogramName = "", dqmProgname = "ana") {
    return mjsonrpc_call("brpc", { "client_name": dqmProgname, "cmd":"dqm::clear", "args":histogramName }, "arraybuffer");
}

/** @brief Puts a resize icon in the bottom right corner to allow resizing the MPlotGraph.
 *
 * @param mPlotGraph The MPlotGraph instance to allow resizing on.
 * @param enclosingDiv The div element that encloses the MPlotGraph. If unset defaults to `mPlotGraph.parentDiv`.
 * You can provide this if you want a div higher up the hierarchy, so that e.g. buttons inside the higher div get
 * resized as well.
 */
function makeResizable(mPlotGraph, enclosingDiv = mPlotGraph.parentDiv) {
    // First make sure the div is not full width
    enclosingDiv.style.display = "inline-block";
    // Enable CSS resizing on the div
    enclosingDiv.style.verticalAlign = "top";
    enclosingDiv.style.resize = "both";
    enclosingDiv.style.overflow = "hidden";

    // Store on the mPlotGraph how big the borders are, so that we can resize it properly
    mPlotGraph.divBorderX = enclosingDiv.clientWidth - mPlotGraph.canvas.width;
    mPlotGraph.divBorderY = enclosingDiv.clientHeight - mPlotGraph.canvas.height;

    mPlotGraph.resizeObserver = new ResizeObserver((entries) => {
        requestAnimationFrame(() => {
            mPlotGraph.canvas.width = entries[0].target.clientWidth - mPlotGraph.divBorderX;
            mPlotGraph.canvas.height = entries[0].target.clientHeight - mPlotGraph.divBorderY;
            mPlotGraph.draw();
        });
    });
    mPlotGraph.resizeObserver.observe(enclosingDiv);
}

/** @brief A convenience class users can create to take care of updating a set of histograms at a set time interval.
 *
 * This is not as trivial as you'd at first think, because there are a lot asynchronous calls going on and we don't
 * want these to trigger multiple concurrent updates. Pauses updates when the tab is not visible.
 *
 * Still to add:
 * It doesn't pause when the run is stopped. Currently it will keep trying to update every histogram when the run is
 * stopped even though the data will not have changed.
 */
class PlotAutoUpdater {
    constructor() {
        // We want to be able to pause updates when the tab is not visibile, so listen
        // for changes in that.
        document.addEventListener("visibilitychange", this.#visibilitychange.bind(this));
    }

    /** @brief Add a plot to the update loop with the given source path.
     *
     * @param mPlotGraph The MPlotGraph to draw the plot in.
     * @param source Can be either a single source, or an array to draw multiple series on the same
     * graph. Each source can either be a string path, or an object with the path set in the `name`
     * property, and an array of run numbers in the `runs` property. If `runs` is not set, the default
     * run numbers are used, which can be set with the setDefaultRunNumbers method.
     */
    addPlot(mPlotGraph, source) {
        // We store the source on the plot itself for ease.
        mPlotGraph.dqmSource = source;

        // Avoid registering the same plot twice.
        if (!this.#plots.includes(mPlotGraph)) {
            this.#plots.push(mPlotGraph);
        }
    }

    /** @brief Remove a plot from the update loop.
     *
     * This stops automatic refreshes for a plot that has been removed from the DOM.
     */
    removePlot(mPlotGraph) {
        this.#plots = this.#plots.filter(existingPlot => existingPlot !== mPlotGraph);

        if (mPlotGraph) {
            mPlotGraph.dqmSource = undefined;
        }
    }

    /** @brief Change the source for the given plot.
     *
     * See the documentation for `addPlot` for a description of what the source can be. */
    changeSource(mPlotGraph, newSource, updateNow = false) {
        if (!this.#plots.includes(mPlotGraph)) {
            return;
        }

        mPlotGraph.dqmSource = newSource;

        // Update just this plot immediately if requested.
        if (updateNow) {
            this.updatePlot(mPlotGraph, mPlotGraph.dqmSource);
        }
    }

    /** @brief Set the run numbers the plots should be for, unless they override the setting in their source.
     *
     * This should be an array of all the run numbers required. Zero means the current run. By default this
     * starts out as `[0]`. */
    setDefaultRunNumbers(runNumbers) {
        this.#defaultRunNumbers = runNumbers;
    }

    /** @brief The Midas "progname" to query data from. This is "ana" by default.
     *
     * The default should almost always be "ana", but if you started minalyzer with the '--midas-progname myprogname'
     * flag.
     */
    setDefaultDQMProg(progName) {
        this.#defaultDQMProg = progName;
    }

    start(updateInterval) {
        this.#updateInterval = updateInterval;
        // Perform an update immediately. At the end of this a setTimeout will be called
        // to update in another updateInterval milliseconds.
        this.#updateLoop();
    }

    refreshAll() {
        // I'm worried if I start a loop while one is still in progress they will interfere.
        // I'll try it and refine if there are problems.
        this.#updateLoop();
    }

    updatePlot(mPlotGraph, source) {
        if (!this.#plots.includes(mPlotGraph)) return Promise.resolve();
        if (source === undefined) return Promise.resolve(); // API requires returning a Promise

        // If the user specified notification callbacks, call them
        if(typeof mPlotGraph.onUpdateStart === 'function') {
            mPlotGraph.onUpdateStart();
        }

        // `source` can be either a single string, which is the DQM path of the desired plot, or
        // an array of these strings in which case the data will be different series on the same
        // plot. If it is a single string, convert it to an array of length 1 so that we can handle
        // them the same way.
        let sourceAsArray = (source.constructor === Array ? source : [source]);

        let promise = undefined;

        // Loop through all the data sources in turn and plot as different series on the same
        // plot. Note that 2D plots only work with a single source.
        let defaultRunNumbers = this.#defaultRunNumbers; // `this` not available in updateFunction
        let defaultDQMProg = this.#defaultDQMProg
        for(let index = 0; index < sourceAsArray.length; ++index) {
            let updateFunction = function() {
                let runs = defaultRunNumbers;
                let name = sourceAsArray[index]; // First assume the source is given as a string
                let dqmProg = defaultDQMProg;
                // Now check if the source is an object with name and runs specified
                if(sourceAsArray[index].hasOwnProperty("runs")) runs = sourceAsArray[index].runs;
                if(sourceAsArray[index].hasOwnProperty("name")) name = sourceAsArray[index].name;
                if(sourceAsArray[index].hasOwnProperty("prog")) dqmProg = sourceAsArray[index].prog;

                return getHistogram(name, runs, dqmProg).then((histogram) => {
                    mPlotGraph.error = null;
                    displayHistogram(histogram, mPlotGraph, index);
                },
                (error) => {
                    // We couldn't get the new histogram. We can't leave what was there before or
                    // people will think they're seeing the histogram they asked for. This is the
                    // only way I know to clear an MPlotGraph.
                    mPlotGraph.param.plot[0].xData = undefined;
                    mPlotGraph.error = error;
                    mPlotGraph.redraw();
                });
            };

            // For the first one we call directly. For all subsequent data sources we chain
            // `then` promises on to the first so that the plots are updated sequentially to
            // ease load on the RPC system.
            if(promise === undefined) promise = updateFunction();
            else promise = promise.then(() => { updateFunction(); });
        }

        // See if the user specified a callback for them to do something after updates
        if(typeof mPlotGraph.onUpdateComplete === 'function') {
            promise.then(() => mPlotGraph.onUpdateComplete());
        }

        return promise;
    }

    set updateInterval(updatTimeInMilliseconds) {
        if(this.#timeoutID !== undefined) clearTimeout(this.#timeoutID);
        this.#timeoutID = undefined;

        this.#updateInterval = updatTimeInMilliseconds;

        if(this.#updateInterval > 0 && !document.hidden) {
            this.#timeoutID = setTimeout(this.#updateLoop.bind(this), this.#updateInterval);
        }
    }

    get updateInterval() {
        return this.#updateInterval;
    }

    #plots = [];
    #updateInterval = 0;
    #timeoutID = undefined;
    #defaultRunNumbers = [0]; // Default to the current run (zero means the current run)
    #defaultDQMProg = "ana"; // minalyzer identifies itself to Midas as "ana", if not changed.

    #visibilitychange(event) {
        if(document.hidden) {
            // If an update is in flight stop it.
            if(this.#timeoutID !== undefined) clearTimeout(this.#timeoutID);
            this.#timeoutID = undefined;
        }
        else if(this.#updateInterval > 0) {
            // Update everything immediately. If required a setTimeout call will be issued when
            // that is finished.
            this.#updateLoop();
        }
    }

    #updateLoop(plotIndex = 0, plotsSnapshot = undefined) {
        if (plotsSnapshot === undefined) {
            plotsSnapshot = [...this.#plots];

            if (plotsSnapshot.length > 0 && typeof this.onUpdateStart === 'function') {
                this.onUpdateStart();
            }
        }

        if (plotIndex < plotsSnapshot.length) {
            const plot = plotsSnapshot[plotIndex];

            this.updatePlot(plot, plot.dqmSource).catch((error) => {
                console.log(error);
            }).finally(() => {
                // Call recursively to update each plot in turn.
                if (!document.hidden) {
                    this.#updateLoop(plotIndex + 1, plotsSnapshot);
                }
            });
        } else {
            if (plotsSnapshot.length > 0 && typeof this.onUpdateComplete === 'function') {
                this.onUpdateComplete();
            }

            // We've finished updating all the plots, update again after the requested period.

            // Make sure we only ever have one timeout in flight at one time.
            if (this.#timeoutID !== undefined) clearTimeout(this.#timeoutID);
            this.#timeoutID = undefined;

            if (this.#updateInterval > 0 && !document.hidden) {
                this.#timeoutID = setTimeout(this.#updateLoop.bind(this), this.#updateInterval);
            }
        }
    }
} // end of class PlotAutoUpdater

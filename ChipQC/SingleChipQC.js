window.ASICMaskManager = {
    maskVec: null,
    nChipsPerSide: null,
    asicMaskPath: "/Equipment/LinksCentral/Settings/ASICMask",
    suspendWatcher: false,

    init(config, maskVec) {
        Promise.all([mjsonrpc_db_get_values(["/PixelQC/Setup"]), mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"])]).then(([rpc, rpc0]) =>
        {
            const setup = rpc.result.data[0] || {};

            const streams = setup.streams || [];
            const febs = setup.feb || [];
            const feb_pos = setup.feb_pos || [];

            const idxUS = streams.indexOf("US");
            const idxDS = streams.indexOf("DS");

            this.feb_us = Number(idxUS >= 0 ? febs[idxUS] : 0);
            this.feb_ds = Number(idxDS >= 0 ? febs[idxDS] : 0);
            this.feb_pos_us = Number(idxUS >= 0 ? feb_pos[idxUS] : 0);
            this.feb_pos_ds = Number(idxDS >= 0 ? feb_pos[idxDS] : 0);

            this.dut = rpc0.result.data[0];
            this.linkmapping = new Link_mapping(
                this.dut,
                this.feb_us,
                this.feb_ds,
                this.feb_pos_us,
                this.feb_pos_ds
            );
            this.applyToGeometry();
        });

        const chipCount = config.chipCount;
        this.nChipsPerSide = Math.floor(chipCount / 2);
        this.maskVec = maskVec.map(Number);
        console.log("Loaded ASIC mask:", ASICMaskManager.maskVec);
    },

    getLadderPos(chip)
    {
        const ladder = chip.closest('.unit-ladder');
        return ladder?.dataset?.id
            ? (JSON.parse(ladder.dataset.id).ladder || 1) - 1
            : 0;
    },

    toggle(chip_pos, selected, ladder_pos)
    {
        let [vec_idx, bit_pos] = this.linkmapping.getASICMapping(chip_pos, ladder_pos);
        let mask = this.maskVec[vec_idx];
        console.log("selected:", selected)
        let val = Math.floor(mask / (2 ** bit_pos)) % 2;

        let toggle = selected ? 1 : 0;

        if (val !== toggle)
        {
            if (toggle === 1)
                mask += 2 ** bit_pos;
            else
                mask -= 2 ** bit_pos;
        }
        this.maskVec[vec_idx] = mask;
        if (!this.suspendWatcher) {
            this.syncToODB();
        }
    },

    applyToGeometry()
    {
        document.querySelectorAll('.unit-chip').forEach(chip =>
        {
            const id = JSON.parse(chip.dataset.id);
            const chip_pos = id.chip - 1;
            let ladder_pos = this.getLadderPos(chip);
            let [vec_idx, bit_pos] = this.linkmapping.getASICMapping(chip_pos, ladder_pos);
            let mask = this.maskVec[vec_idx];
            const masked = Math.floor(mask / (2 ** bit_pos)) % 2;
            chip.classList.toggle('selected', masked);
        });

        const allLadders = document.querySelectorAll('.unit-ladder');
        allLadders.forEach(ladder =>
        {
            if (!ladder._geoElement) return;
            const allSelected = ladder._geoElement.children.every(child => child.div.classList.contains('selected'));
            ladder.classList.toggle('selected', allSelected);
        });

        const allModules = document.querySelectorAll('.unit-module');
        allModules.forEach(module =>
        {
            if (!module._geoElement) return;
            const allSelected = module._geoElement.children.every(child => child.div.classList.contains('selected'));
            module.classList.toggle('selected', allSelected);
        });
    },

    syncToODB() {
        console.log("Update ASIC mask to ODB:", this.maskVec.map(x => x.toString(2)));
        mjsonrpc_db_set_value(
            this.asicMaskPath,
            this.maskVec
        ).then( function(rpc) {
            mjsonrpc_db_paste(["/Equipment/LinksCentral/Settings/Rebuild"], [true]);
        }).catch(err => console.error("Failed to update ASIC mask:", err));
    },

    refreshFromODB() {
        console.log("Refreshing from ODB...");
        mjsonrpc_db_get_values([this.asicMaskPath])
            .then((rpc) => {
                if (rpc.result.data && rpc.result.data[0]) {
                    this.maskVec = rpc.result.data[0].map(Number);
                    this.applyToGeometry();
                }
            })
            .catch(err => console.error("Failed to refresh ASIC mask from ODB:", err));
    }

};

// Inputs from Luigi
/*
function from_chip_pos_to_asic_mask(chip_pos) {
    //here chip_pos is assumed from 0
    let feb_us = 0
    let feb_ds = 1
    let feb_pos_us = 0
    let feb_pos_ds = 0
    let n_chips_per_side = 9
    if (chip_pos < n_chips_per_side) {
        return feb_us, chip_pos + feb_pos_us*n_chips_per_side //array index, bit position
    }
    else {
        return feb_ds, chip_pos + feb_pos_ds*n_chips_per_side //array index, bit position
    }
}

function get_asic_mask(asic_mask_vect, chip_pos) { //asic_mask_vec from odb
    let vec_idx, bit_pos = from_chip_pos_to_asic_mask(chip_pos)
    let mask = asic_mask_vect[vec_idx]
    return Math.floor(mask/(2**bit_pos))%2
}

function toggle_chip_selected_asic_mask(asic_mask_vec, chip_pos, toggle) { //asic_mask_vec from odb, toggle = 0,1 depending if chip is selected
    let vec_idx, bit_pos = from_chip_pos_to_asic_mask(chip_pos)
    let mask = asic_mask_vec[vec_idx]
    let val = Math.floor(mask/(2**bit_pos))%2
    if (val != toggle) {
        if (toggle == 1)
            mask += 2**bit_pos
        else
            mask -= 2**bit_pos
    }
    asic_mask_vec[vec_idx] = mask
    return asic_mask_vec //to be set back in the odb
}
*/

const lvds_link_order = [33,31,29,35,32,28,34,30,27,26,25,20,24,23,21,22,19,18,15,11,9,17,13,10,16,14,12,5,3,2,6,4,1,8,7,0].reverse()

function get_LVDS_link_invert(lvds_links_invert, feb, link_id) {
    let link_mask = parseInt(lvds_links_invert[feb])
    return Math.floor(link_mask/(2**lvds_link_order[link_id]))%2
}

function toggle_LVDS_link_invert(lvds_links_invert, feb, link_id) {
    let link_mask = parseInt(lvds_links_invert[feb])
    let val = Math.floor(link_mask/(2**lvds_link_order[link_id]))%2
    if (val == 0)
        link_mask += 2**lvds_link_order[link_id]
    if (val == 1)
        link_mask -= 2**lvds_link_order[link_id]
    //link_mask &= ~(1 << link_id)
    lvds_links_invert[feb] = link_mask
    console.log("Uninvert link of FEB", feb, ", original position = ", link_id, ", real position = ", lvds_link_order[link_id])
    mjsonrpc_db_paste(["/Equipment/LinksCentral/Settings/LVDSLinkInvert"], [lvds_links_invert]).then(function (rpc) {
        // callback()
    })
}

function load_dacs_beginning(){
    var dac_chip_number = 0;
    dac_list = ["BIASDACS", "CONFDACS", "VDACS","MODES"];
    for (var dac = 0; dac < dac_list.length; ++dac) {
        var dac_name = dac_list[dac];
        var table = document.getElementById(dac_name);

        // Clear table rows
        while (table.rows.length > 0) {
            table.deleteRow(0);
        }

        // Add header row
        var headerRow = table.insertRow(-1);
        var headerCell = headerRow.insertCell(0);
        headerCell.colSpan = 2;
        headerCell.innerHTML = dac_name;
        headerCell.classList.add("mtableheader");

        // Add column headers
        var headerRow2 = table.insertRow(-1);
        var nameHeader = headerRow2.insertCell(0);
        var valueHeader = headerRow2.insertCell(1);
        nameHeader.innerHTML = "Name";
        valueHeader.innerHTML = "Value";

        // Add rows for DAC values
        for (var i = 0; i < Mupix_DACs[dac_name].length; ++i) {
            var row = table.insertRow(-1);
            var cell1 = row.insertCell(0);
            var cell2 = row.insertCell(1);

            cell1.innerHTML = Mupix_DACs[dac_name][i];
            cell2.classList.add("modbvalue");
            var link = "/Equipment/PixelsCentral/Settings/" + dac_name + "/" + dac_chip_number.toString() +
                "/" + Mupix_DACs[dac_name][i];
            cell2.setAttribute("data-odb-path", link);
            cell2.setAttribute("data-odb-editable", "1");
        }
    }}
load_dacs_beginning()
function dac_update_chip_number(event) {
    const dac_chip_number = event.target.value;
    if (dac_chip_number != 999) {
        dac_list = ["BIASDACS", "CONFDACS", "VDACS","MODES"];
        for (var dac = 0; dac < dac_list.length; ++dac) {
            var dac_name = dac_list[dac];
            var table = document.getElementById(dac_name);

            // Clear table rows
            while (table.rows.length > 0) {
                table.deleteRow(0);
            }

            // Add header row
            var headerRow = table.insertRow(-1);
            var headerCell = headerRow.insertCell(0);
            headerCell.colSpan = 2;
            headerCell.innerHTML = dac_name;
            headerCell.classList.add("mtableheader");

            // Add column headers
            var headerRow2 = table.insertRow(-1);
            var nameHeader = headerRow2.insertCell(0);
            var valueHeader = headerRow2.insertCell(1);
            nameHeader.innerHTML = "Name";
            valueHeader.innerHTML = "Value";

            // Add rows for DAC values
            for (var i = 0; i < Mupix_DACs[dac_name].length; ++i) {
                var row = table.insertRow(-1);
                var cell1 = row.insertCell(0);
                var cell2 = row.insertCell(1);

                cell1.innerHTML = Mupix_DACs[dac_name][i];
                cell2.classList.add("modbvalue");
                var link = "/Equipment/PixelsCentral/Settings/" + dac_name + "/" + dac_chip_number.toString() +
                    "/" + Mupix_DACs[dac_name][i];
                cell2.setAttribute("data-odb-path", link);
                cell2.setAttribute("data-odb-editable", "1");
            }
        }
    }
}

//Add local channel assignment to Power Setup page
//Based on LocalConfig.js
function updateLVdescriptions() {
    var stpID = ""
    mjsonrpc_db_get_values(["/PixelQC/Setup/Setup"]).then(function(rpc) {
        stpID = rpc.result.data[0]
        // Choose the appropriate list based on stpID
        var selectedList = LVSUPPLY0_descr;
        if (stpID === "PSI") {
            selectedList = LVSUPPLY0_descr_psiQC1;}
        else if (stpID === "OxQC33") {
            selectedList = LVSUPPLY0_descr_oxford;}
        else if (stpID === "OxQC43") {
            selectedList = LVSUPPLY0_descr_oxford_ladder;}
        else if (stpID == "OxQC08") {
            selectedList = LVSUPPLY0_descr_OxQC08;}
        else if (stpID === "Probestation") {
            selectedList = LVSUPPLY0_descr_oxford;}
        else if(stpID === "PSI_QC2"){
            selectedList = LVSUPPLY0_descr_psiQC2;}
        else if (stpID == "HD") {
            selectedList = LVSUPPLY0_descr_HD;}
        else if(stpID === "Uzh"){
                selectedList = LVSUPPLY0_descr_uzh;}
        for (var ch = 0; ch < selectedList.length; ++ch) {
            var did = "LVSUPPLY0_descr" + ch.toString();
            var descr = document.getElementById(did);
            descr.textContent = selectedList[ch];
        }
    })
}
//initialize LV descr:
updateLVdescriptions();

var loaded_sequencer_script = ""

//document.getElementById("seqLoadedFile").addEventListener('DOMSubtreeModified', function() {
//    if (document.getElementById("seqLoadedFile").textContent != loaded_sequencer_script){// && document.getElementById("seqLoadedFile").textContent.includes("Loading") == false) {
//        console.log("New file loaded: " + document.getElementById("seqLoadedFile").textContent)
//        loaded_sequencer_script = document.getElementById("seqLoadedFile").textContent
//        update_sequencer_vals_to_default()
//    }
    //else {
    //    console.log("NO new file loaded: " + document.getElementById("seqLoadedFile").textContent)
    //}
//})

function enforceNegativeInput(x) {
    if (x.value > 0) {
        return false;
    }
    return true;
}

var full_config = {};
var dac_library = {};
var temp = 0;

async function populateDynamicParamTable(script_name) {
    const [mapping, tableId] = getQCParameterList(script_name);

    if (!tableId) {
        console.error(`No table mapping found for script "${script_name}".`);
        return;
    }

    const table = document.getElementById(tableId);
    if (!table) {
        console.error(`Table with id "${tableId}" not found.`);
        return;
    }

    while (table.rows.length > 2) {
        table.deleteRow(2);
    }

    try {
        // Get keys from /PySequencer/Param/Value
        const ls = await mjsonrpc_db_ls(["/PySequencer/Param/Value"]);
        const obj = ls.result.data[0];

        // Filter only true parameter names (exclude "/key")
        const keys = Object.keys(obj).filter(k => !k.endsWith("/key"));

        // For each parameter, fetch value + comment
        for (const key of keys) {

            const path = [`/PySequencer/Param/Comment/${key}`];

            const rpc = await mjsonrpc_db_get_values(path);
            const data = rpc.result.data || [];

            const comment = data[0];

            const row = table.insertRow(-1);
            const cell1 = row.insertCell(0);
            const cell2 = row.insertCell(1);

            cell1.style.whiteSpace = "pre-line";
            cell1.textContent = comment;

            cell2.classList.add("modbvalue");
            if (script_name in QCParameterListPretty && key in QCParameterListPretty[script_name]) {
                let key_type = QCParameterListPretty[script_name][key]["type"]
                let key_values = QCParameterListPretty[script_name][key]["values"]
                if (key_type == "string") {
                    let option_box = document.createElement("select")
                    option_box.classList.add("modbselect")
                    option_box.setAttribute("data-odb-path", `/PySequencer/Param/Value/${key}`);
                    for (const [value, name] of Object.entries(key_values)) {
                        let option_val = document.createElement("option");
                        option_val.text = name
                        option_val.setAttribute("value", value)
                        option_box.add(option_val)
                    }
                    cell2.appendChild(option_box)
                }
                else //type not recognised, go default
                    cell2.setAttribute("data-odb-path", `/PySequencer/Param/Value/${key}`);
                    cell2.setAttribute("data-odb-editable", "1");
            }
            else {
                cell2.setAttribute("data-odb-path", `/PySequencer/Param/Value/${key}`);
                cell2.setAttribute("data-odb-editable", "1");
            }
        }

        if (script_name === "full_qc.py") {

            const table2 = document.getElementById("qcOptions");

            while (table2.rows.length > 2) {
                table2.deleteRow(2);
            }

            const qc_par_list = mapping;
            const optionNames = QC_options[qc_par_list[0]];
            const optionLabels = QC_options[qc_par_list[1]];

            for (let i = 0; i < optionNames.length; i++) {
                const parameter = optionNames[i];
                const row = table2.insertRow(-1);
                const cell1 = row.insertCell(0);
                const cell2 = row.insertCell(1);

                cell1.textContent = optionLabels[i];
                cell2.classList.add("modbvalue");

                const link = `/PixelQC/Flags/${parameter}`;
                cell2.setAttribute("data-odb-path", link);
                cell2.setAttribute("data-odb-editable", "1");
            }
        }
    } catch (error) {
        console.error("populateDynamicParamTable error:", error);
    }
}



function getQCParameterList(script_name) {
    // Define mappings of script names to parameter lists here
    const mappings = {
        "check_contact.py": ["Check_contact", "Check_contact_text"],
        "iv_scan.py": ["IV", "IV_text"],
        "vdac_scans.py": ["VDAC", "VDAC_text"],
        "vdac_power_consumption.py": ["VDAC_power", "VDAC_power_text"],
        "onChip_voltages.py": ["onChip_voltages", "onChip_voltages_text"],
        "signal_transmission.py": ["signal_transmission", "signal_transmission_text"],
        "lvds_links.py": ["lvds_links", "lvds_links_text"],
        "noise_scan.py": ["noise_scan", "noise_scan_text"],
        "full_qc.py": ["full", "full_text"],
        // Add more mappings as needed
    };

    const tables = {
        "check_contact.py": "qcCheckContactParameters",
        "iv_scan.py": "qcIVparameters",
        "vdac_scans.py": "qcVDACscanParameters",
        "vdac_power_consumption.py": "qcVDACpowerConsumptionsParameters",
        "onChip_voltages.py": "qcOnChipVoltagesParameters",
        "signal_transmission.py": "qcSignalTransmissionParameters",
        "lvds_links.py": "qcLVDSlinksParameters",
        "noise_scan.py": "qcNoiseScanParameters",
        "source_scan.py": "qcSourceScanParameters",
        "full_qc.py": "qcFullParameters",
        // Add more table mappings as needed
    };

    return [mappings[script_name], tables[script_name]];
}

const QCParameterListPretty = {
    "full_qc.py" : {
        "start_from_scan" : {
            "type" : "string",
            "values" : {
                0 : "Beginning",
                1 : "IV scan",
                2 : "On-chip Voltages",
                3 : "VDAC scan",
                4 : "VDAC power consumption",
                5 : "Signal Transmission",
                6 : "LVDS links",
                7 : "Noise scan",
            }
        }
    }
}

function load(){
    //mhttpd_init('Pixel test helper', 100);

    mjsonrpc_db_ls(["/Equipment/PixelsCentral/Settings/BIASDACS/0",
                   "/Equipment/PixelsCentral/Settings/CONFDACS/0",
                   "/Equipment/PixelsCentral/Settings/VDACS/0",
                   "/Equipment/PixelsCentral/Settings/MODES/0"
                ]).then(function(rpc) {

           // Populate dac_library with all DACs at /Equipment/PixelsCentral/Settings/
           var result = rpc.result;
           dac_library = {'BIASDACS': result.data[0],
                          'CONFDACS': result.data[1],
                          'VDACS':result.data[2],
                          'MODES':result.data[3]};
       }).catch(function(error) {
           console.log("Error getting info on DACs avaliable for change in ODB:", error);
       });

    /*document.getElementById("autotest_IV").addEventListener('DOMSubtreeModified', function () {
        if (document.getElementById("autotest_IV").innerHTML == "y")
                document.getElementById("status_report").innerHTML = "IV test required!";
        else
                document.getElementById("status_report").innerHTML = "Nothing to do";
        });*/
}

load();

var convert_v_to_temperature = function (volt) {
    var volt2 = (volt/2)
    var I_0 = 950;
    var a_0 = 2;
    var I_1 = 1300;
    var a_1 = 2;
    var p0_0 = 228;
    var p1_0 = -0.3318;
    var p1_1 = p1_0 * (I_1 / I_0) * (a_0 / a_1);
    return p0_0 + p1_0 * (volt2*1000);
}

var setup_listeners = function () {
    document.getElementById("adc_read_2").addEventListener('DOMSubtreeModified', function () {
        document.getElementById("monit_temperature").innerHTML = convert_v_to_temperature(this.textContent);
    })
}


/* something else*/

function handleFile() {
    const [file] = document.querySelector('input[type=file]').files;
    const reader = new FileReader();

    reader.addEventListener("load", async function() {
        // TODO implement async json parsing
        try {
            full_config = await JSON.parse(reader.result);
        } catch (err) {
            console.log("Could not read input config file:", err)
        }

    }, false);

    if (file) {
        reader.readAsText(file);
    }

    console.log("File loaded")
}

function uploadConfigToODB(req_id){ //TODO TRY OUT
    // Filter out empty named dacs for full_config:
    let filepath = document.getElementById("jsonInputConfig").value;
    if (full_config != {} && filepath != ""){
        let content = document.getElementById("log");
        let form = document.getElementById("mupixID")

        let mupix = "0";

        if (temp == 0){
            temp = {};
            for (var i in full_config.zdacs){
                let name = full_config.zdacs[i].name;
                let value = full_config.zdacs[i].value;

                if (name != ''){
                    temp[name] = value;
                }
            }
            // Copy result to full_config
            full_config = temp;
        } else {
            console.log("Not first time, full config already updated")
        }

        // Iterate over each full_config dac, check if its in dac_library and
        // set order to ODB
        var paths = []
        var values = []

        for (var dac in full_config){
            if (Object.keys(dac_library.BIASDACS).includes(dac)){
                paths[paths.length] = "/Equipment/PixelsCentral/Settings/BIASDACS/"+mupix+"/"+dac
                values[values.length] = full_config[dac]
                console.log("Entered BIAS")
            } else if (Object.keys(dac_library.CONFDACS).includes(dac)){
                paths[paths.length] = "/Equipment/PixelsCentral/Settings/CONFDACS/"+mupix+"/"+dac
                values[values.length] = full_config[dac]
                console.log("Entered CONF")
            }
            else if (Object.keys(dac_library.VDACS).includes(dac)){
                paths[paths.length] = "/Equipment/PixelsCentral/Settings/VDACS/"+mupix+"/"+dac
                values[values.length] = full_config[dac]
                console.log("Entered VDACS")
            }
            else if (Object.keys(dac_library.MODES).includes(dac)){
                paths[paths.length] = "/Equipment/PixelsCentral/Settings/MODES/"+mupix+"/"+dac
                values[values.length] = full_config[dac]
                console.log("Entered MODES")
            }
            else {
                console.log('DAC', dac ,' in input JSON file not present in ODB');
            }
        }

        mjsonrpc_db_paste(paths, values).then(function (rpc){
            let now = new Date();
            content.innerText += "\nUPLOADED to mupix "+ mupix +": " + now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds();
        }).catch(function (error){
            mjsonrpc_error_alert(error);
        })

    } else {
        dlgAlert("Upload file, please")
    }
}

function execute_sequencer_script(script_name, script_path=homeFolder+"/online/pixels/python_qc/scripts/") {
    //paths = ["/Sequencer/State/Path", "/Sequencer/State/Filename"]
    //vals = [script_path, script_name]
    paths = ["/PySequencer/State/Filename"]
    vals = [script_name]
    mjsonrpc_db_paste(paths, vals).then(rpc => {
        paths2 = ["/PySequencer/Command/Load filename"]
        vals2 = [script_name]
        mjsonrpc_db_paste(paths2, vals2).then(rpc2 => {
            paths3 = ["/PySequencer/Command/Load new file"]
            vals3 = [1]
            mjsonrpc_db_paste(paths3, vals3).then(rpc3 => {
                paths4 = ["/PySequencer/Command/Start script"]
                vals4 = [1]
                mjsonrpc_db_paste(paths4, vals4).then(rpc4 => {
                    return;
                }).catch(function(error) {
                    console.log(error);
                });
          })
        })
    })
}


async function load_sequencer_script(script_name, script_path = homeFolder + "/online/pixels/python_qc/scripts/") {
    try {
        await mjsonrpc_db_paste(["/PySequencer/State/Filename", "/PySequencer/Command/Load new file"], [script_name, 1]);

        // Wait until Load new file becomes 0
        while (true) {
            const rpc = await mjsonrpc_db_get_values(["/PySequencer/Command/Load new file"]);
            const loadNewFileValue = rpc.result.data[0];
            if (loadNewFileValue === false) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await populateDynamicParamTable(script_name);
    } catch (error) {
        console.log(error);
    }
}

//----------------------------------
//QC loading (e.g. Sequencer scripts)

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function MaskNonWorkingLinks(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {
        execute_sequencer_script("mask_bad_links.py");
        }
}


async function UnMaskAll(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {
        execute_sequencer_script("unmask_all.py");
        }
}



async function configureMupix(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {if (id == "configButton_1"){
        const chipNumber = document.getElementById('dac_chip_number').value;
        await mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"],[chipNumber.toString()]);}
        execute_sequencer_script("configure_chips.py");
        }
}

async function setDefaultDACs(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {if (id == "loadDefaultDACs_1"){
        const chipNumber = document.getElementById('dac_chip_number').value;
        await mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"], [chipNumber.toString()]);}
        execute_sequencer_script("set_default_dacs_customPage.py");
        }
}

async function ResetPLL(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {if (id == "reset_pll_1"){
        const chipNumber = document.getElementById('dac_chip_number').value;
        await mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"], [chipNumber.toString()]);}
        execute_sequencer_script("Reset_PLL.py");
        }
}
async function ResetBiasBlock(id) {
    let rpc = await mjsonrpc_db_get_values(["/PySequencer/State/Running"]);
    let running = rpc.result.data[0];
    if (running != 1)
        {if (id == "reset_bias_block"){
        const chipNumber = document.getElementById('dac_chip_number').value;
        await mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"], [chipNumber.toString()]);}
        execute_sequencer_script("Reset_biasBlock.py");
        }
}

function confirmQC_full() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the full chip QC?", sequencerLoadSetFull);
    }
}

function confirmQC_check_contact() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the Check contact test?", sequencerLoadSetCheckContact);
    }
}

function confirmQC_iv_scan() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the IV scan?", sequencerLoadSetIV);
    }
}

function confirmQC_vdac() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the VDAC scan?", sequencerLoadSetVDAC);
    }
}

function confirmQC_vdac_power() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the VDAC power consumption scan?", sequencerLoadSetVDACpower);
    }
}

function confirmQC_onChip_voltages() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the on-chip voltages measurement?", sequencerLoadSetOnChipVoltages);
    }
}

function confirmQC_signal_transmission() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the signal transmission test?", sequencerLoadSetSignalTransmission);
    }
}

function confirmQC_lvds_links() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the LVDS link test?", sequencerLoadSetLVDSlinks);
    }
}

function confirmQC_noise_scan() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the noise scan?", sequencerLoadSetNoiseScan);
    }
}

function confirmQC_source_scan() {
    running = document.getElementById("seqRun");
    if (running.value == true) {
        dlgAlert("PySequencer is already running!");
    }
    else {
        dlgConfirm("Are you sure to load the source scan?", sequencerLoadSetSourceScan);
    }
}

function confirmSequencerStart_QCInd() {
    dlgConfirm("Are you sure to start the QC script?", sequencerStart);
}

function confirmSequencerStart_QCFull() {
    dlgConfirm("Are you sure to start the full QC test?", sequencerStart);
}

function sequencerLoadSetFull(flag) {
    if (flag) {
        load_sequencer_script("full_qc.py");
    }
}

function sequencerLoadSetCheckContact(flag) {
    if (flag) {
        load_sequencer_script("check_contact.py");
    }
}

function sequencerLoadSetIV(flag) {
    if (flag) {
        load_sequencer_script("iv_scan.py");
    }
}

function sequencerLoadSetVDAC(flag) {
    if (flag) {
        load_sequencer_script("vdac_scans.py");
    }
}

function sequencerLoadSetVDACpower(flag) {
    if (flag) {
        load_sequencer_script("vdac_power_consumption.py");
    }
}

function sequencerLoadSetOnChipVoltages(flag) {
    if (flag) {
        load_sequencer_script("onChip_voltages.py");
    }
}

function sequencerLoadSetSignalTransmission(flag) {
    if (flag) {
        load_sequencer_script("signal_transmission.py");
    }
}

function sequencerLoadSetLVDSlinks(flag) {
    if (flag) {
        load_sequencer_script("lvds_links.py");
    }
}

function sequencerLoadSetNoiseScan(flag) {
    if (flag) {
        load_sequencer_script("noise_scan.py");
    }
}

function sequencerLoadSetSourceScan(flag) {
    if (flag) {
        load_sequencer_script("source_scan.py");
    }
}


async function sequencerStart(flag) {
    if (flag) {
        //await update_sequencer_vals_to_default();
        modbset("/PySequencer/Command/Start script", 1);
    }
}

//----------------------------------
//Sequencer controlling

function confirmSequencerStop() {
    dlgConfirm("Are you sure to stop the PySequencer?", sequencerStop);
}

function confirmSequencerPause() {
    dlgConfirm("Are you sure to pause the PySequencer?", sequencerPause);
}

function confirmSequencerResume() {
    dlgConfirm("Are you sure to resume the PySequencer?", sequencerResume);
}

function sequencerStop(flag) {
    if (flag) {
        modbset("/PySequencer/Command/Stop immediately", 1);
    }
}

function sequencerPause(flag) {
    if (flag) {
        modbset("/PySequencer/Command/Pause script", 1);
    }
}

function sequencerResume(flag) {
    if (flag) {
        modbset("/PySequencer/Command/Resume script", 1);
    }
}



//-----------------------
//Monitoring

//initialize currents, and define chip area
var chipArea = 4.788988; //2.066 cm x 2.318 cm

// Equipment configuration from /PixelQC/Setup/
const equipmentConfig = {
    US: { lv_name: "", lv_channel: 0, hv_name: "", hv_channel: 0, temp_name: "", temp_channel: 0 },
    DS: { lv_name: "", lv_channel: 0, hv_name: "", hv_channel: 0, temp_name: "", temp_channel: 0 }
};

// Current stream mode ("US", "DS", or "both_sided")
var currentStream = "both_sided";

const monitoringState = {
    US: { LVcurrent: 1.0, LVvoltage: 1.0, LVlimit: 0, HVlimit: 0, LVon: false, HVon: false },
    DS: { LVcurrent: 1.0, LVvoltage: 1.0, LVlimit: 0, HVlimit: 0, LVon: false, HVon: false }
};


function getStatusStyle(value, isOn, tooLow, tooHigh, isCompliance = false) {
    if (!isOn) {
        return { className: "stopped", text: "Off" };  // Using mu3estyle.css .stopped (red bg)
    }
    if (isCompliance) {
        return { className: "alarmCell", text: "Compliance!" };  // Using mu3estyle.css .red
    }
    if (value < tooLow) {
        return { className: "Light", style: "background-color: #4080FF; color: white;", text: precise(value, 3) };
    }
    if (value > tooHigh) {
        return { className: "alarmCell", text: precise(value, 3) };
    }
    return { className: "running", text: precise(value, 3) };  // Using mu3estyle.css .running (green bg)
}

// Update Functions, which are called on odb value changes

function updateLVCurrent(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];

    mjsonrpc_db_get_values(["/PixelQC/Dut/N_chips"]).then(rpc => {
        const nChips = Number(rpc.result.data[0]) || 1;
        state.LVcurrent = Number(value);

        const tooLow = nChips * 0.4;  // 400mA per chip
        const tooHigh = nChips * 0.62; // 620mA per chip
        const isCompliance = Math.abs(state.LVcurrent) > 0.99 * state.LVlimit;

        const statusInfo = getStatusStyle(state.LVcurrent, state.LVon, tooLow, tooHigh, isCompliance);
        const elem = document.getElementById(`lv_status_${stream}`);
        if (elem) {
            elem.className = statusInfo.className;
            if (statusInfo.style) elem.style = statusInfo.style;
            else elem.style = "";
            elem.innerHTML = statusInfo.text;
        }
    }).catch(err => console.error(`updateLVCurrent ${stream} error:`, err));
}

function updateHVCurrent(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];
    const _current = Number(value) * 1e6;  // Convert A to µA

    const tooLow = 0.1;  // 0.1 µA
    const tooHigh = state.HVlimit * 0.99;
    const isCompliance = Math.abs(_current) >= 0.99 * state.HVlimit;

    const statusInfo = getStatusStyle(_current, state.HVon, tooLow, tooHigh, isCompliance);
    const elem = document.getElementById(`hv_status_${stream}`);
    if (elem) {
        elem.className = statusInfo.className;
        if (statusInfo.style) elem.style = statusInfo.style;
        else elem.style = "";
        const showUnit = state.HVon && statusInfo.text !== "Off" && statusInfo.text !== "Compliance!";
        elem.innerHTML = showUnit ? (statusInfo.text + " µA") : statusInfo.text;
    }
}

function updateLVState(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];

    state.LVon = Boolean(value);
    updateLVCurrent(state.LVcurrent, is_ds);

    // Turn on of Temp display
    const tempElem = document.getElementById(`temp_${stream}`);
    if (tempElem) {
        const currentTemp = tempElem.textContent.replace(" °C", "").replace("Off", "0");
        updateTemperature(currentTemp, is_ds);
    }
}

function updateHVState(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];

    state.HVon = Boolean(value);
    const elem = document.getElementById(`hv_status_${stream}`);
    const currentVal = elem?.textContent?.replace(" µA", "") || 0;
    updateHVCurrent(currentVal, is_ds);
}

function updateLVVoltage(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    monitoringState[stream].LVvoltage = Number(value);
}

function updateLVCurrentLimit(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];

    state.LVlimit = Number(value);
    updateLVCurrent(state.LVcurrent, is_ds);
}

function updateHVCurrentLimit(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    monitoringState[stream].HVlimit = Number(value) * 1e6;  // Convert A to µA
}

function updateTemperature(value, is_ds = false) {
    const stream = is_ds ? "DS" : "US";
    const state = monitoringState[stream];
    const elem = document.getElementById(`temp_${stream}`);

    if (elem) {
        if (!state.LVon) {
            elem.innerHTML = "Off";
            elem.style.color = "grey";
        } else {
            const temp = Number(value);
            elem.innerHTML = precise(temp, 4) + " °C";
            elem.style.color = "";
        }
    }
}

function updateErrorcounter() {
    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc0 =>
        {
        let dut = rpc0.result.data[0];
        if (dut == "ladder_inner" || dut == "chip")
        {
        // document.getElementById("error_a").style["visibility"] = "visible";
        // document.getElementById("error_a").style["display"] = "inline-block";
        // document.getElementById("error_b").style["visibility"] = "visible";
        // document.getElementById("error_b").style["display"] = "inline-block";
        // document.getElementById("error_c").style["visibility"] = "visible";
        // document.getElementById("error_c").style["display"] = "inline-block";
        document.getElementById("error_a").style.display = "table-row";
        document.getElementById("error_b").style.display = "table-row";
        document.getElementById("error_c").style.display = "table-row";

        }
        if (dut == "outer_ladder_L3" ||dut == "outer_ladder_L4")
        {
            // document.getElementById("error_link").style["visibility"] = "visible";
            // document.getElementById("error_link").style["display"] = "inline-block";
            document.getElementById("error_link").style.display = "table-row";
        }
        })
}


//updating sequencer status
function updateSeqState() {
    mjsonrpc_db_get_values(["/PySequencer/State/Running",
                            "/PySequencer/State/Paused"]).then(rpc => {
        running = rpc.result.data[0];
        paused = rpc.result.data[1];

        if (paused == 1) {
            document.getElementById("seqActive").className = "yellowLight";
            document.getElementById("seqActive").innerHTML = "Paused";
            document.getElementById("current_qc_score").style["visibility"] = "hidden";
            document.getElementById("current_qc_score").style["display"] = "none";
            document.getElementById("current_limitations").style["visibility"] = "hidden";
            document.getElementById("current_limitations").style["display"] = "none";
        }
        else {
            if (running == 1) {
                document.getElementById("seqActive").className = "greenLight";
                document.getElementById("seqActive").innerHTML = "Running";
                if (document.getElementById("seqLoadedFile").textContent == "full_qc.py" ) {
                    document.getElementById("current_qc_score").style["visibility"] = "visible";
                    document.getElementById("current_qc_score").style["display"] = "inline-block";
                    document.getElementById("current_limitations").style["visibility"] = "visible";
                    document.getElementById("current_limitations").style["display"] = "inline-block";
                }
            }
            else {
                document.getElementById("seqActive").className = "redLight";
                document.getElementById("seqActive").innerHTML = "No";
                document.getElementById("current_qc_score").style["visibility"] = "hidden";
                document.getElementById("current_qc_score").style["display"] = "none";
                document.getElementById("current_limitations").style["visibility"] = "hidden";
                document.getElementById("current_limitations").style["display"] = "none";
                }
        }
    });
}
updateSeqState();



function updateCheckboxState() {
    mjsonrpc_db_get_values(["/PixelQC/Setup/lv_channel[0]",
        "/PixelQC/Setup/Setup", "/PixelQC/Setup/lv_channel[1]"]).then(rpc0 =>
    {
        let lv_channel_chip = rpc0.result.data[0].toString();
        let lv_channel_chip_2 = rpc0.result.data[2].toString();
        let setup = rpc0.result.data[1];
        if (setup == "OxQC43") {
            mjsonrpc_db_get_values(["/Equipment/TA5000/Variables/head","/Equipment/TA5000/Variables/temperature"]).then(rpc0 =>
            {
                let head = rpc0.result.data[0];
                let temp = rpc0.result.data[1];
                if (head == 0 || temp > 10)
                    {
                    modbset("/Equipment/LVSUPPLY0/Variables/Set State[" + lv_channel_chip + "]", false);
                    modbset("/Equipment/LVSUPPLY0/Variables/Set State[" + lv_channel_chip_2 + "]", false);
                    modbset("/Equipment/HVSUPPLY0/Variables/Set State[" + lv_channel_chip + "]", false);
                    modbset("/Equipment/HVSUPPLY1/Variables/Set State[" + lv_channel_chip + "]", false);
                    document.getElementById("lv_enable_checkbox_" + lv_channel_chip).disabled = true;
                    document.getElementById("lv_enable_checkbox_" + lv_channel_chip_2).disabled = true;
                    document.getElementById("hv_enable_checkbox_0").disabled = true;
                    document.getElementById("hv_enable_checkbox_1").disabled = true;
                }
                else
                    {
                    document.getElementById("lv_enable_checkbox_" + lv_channel_chip).disabled = false;
                    document.getElementById("lv_enable_checkbox_" + lv_channel_chip_2).disabled = false;
                    document.getElementById("hv_enable_checkbox_0").disabled = false;
                    document.getElementById("hv_enable_checkbox_1").disabled = false;
                }
            }
        )
	    mjsonrpc_db_get_values(["/Equipment/LVSUPPLY0/Variables/Voltage[0]","/Equipment/LVSUPPLY0/Variables/Voltage[1]","/Equipment/HVSUPPLY0/Variables/Voltage", "/Equipment/HVSUPPLY1/Variables/Voltage", "/Equipment/TEMPDIODE0/Variables/Temperature[0]", "/Equipment/TEMPDIODE0/Variables/Temperature[1]", "/Equipment/TA5000/Commands/CMD_head"]).then(rpc0 =>
	    {
		let lv_voltageUS = rpc0.result.data[0];
		let lv_voltageDS = rpc0.result.data[1];
		let hv_voltageUS = rpc0.result.data[2];
		let hv_voltageDS = rpc0.result.data[3];
		let tempDiodeUS = rpc0.result.data[4];
		let tempDiodeDS = rpc0.result.data[5];
		let TA_headState = rpc0.result.data[6];
		if(TA_headState == 0 && (lv_voltageUS > 0 || lv_voltageDS > 0 || hv_voltageUS > 0 || hv_voltageUS > 0 || tempDiodeUS > 60 || tempDiodeDS > 60))
		    {
			modbset("/Equipment/TA5000/Commands/CMD_head", 1);
		    }
		if((tempDiodeUS > 120 || tempDiodeDS > 120))
		    {
			    modbset("/Equipment/LVSUPPLY0/Variables/Set State[" + lv_channel_chip + "]", false);
			    modbset("/Equipment/LVSUPPLY0/Variables/Set State[" + lv_channel_chip_2 + "]", false);
			    modbset("/Equipment/HVSUPPLY0/Variables/Set State[" + lv_channel_chip + "]", false);
			    modbset("/Equipment/HVSUPPLY1/Variables/Set State[" + lv_channel_chip + "]", false);
			    document.getElementById("lv_enable_checkbox_" + lv_channel_chip).disabled = true;
			    document.getElementById("lv_enable_checkbox_" + lv_channel_chip_2).disabled = true;
			    document.getElementById("hv_enable_checkbox_0").disabled = true;
			    document.getElementById("hv_enable_checkbox_1").disabled = true;
		    }
	    }
	)
        }
    })
}

// Load equipment configuration from /PixelQC/Setup/
function loadEquipmentConfig() {
    return mjsonrpc_db_get_values([
        "/PixelQC/Setup/lv_names[0]",
        "/PixelQC/Setup/lv_names[1]",
        "/PixelQC/Setup/lv_channel[0]",
        "/PixelQC/Setup/lv_channel[1]",
        "/PixelQC/Setup/hv_names[0]",
        "/PixelQC/Setup/hv_names[1]",
        "/PixelQC/Setup/hv_channel[0]",
        "/PixelQC/Setup/hv_channel[1]",
        "/PixelQC/Setup/temp_names[0]",
        "/PixelQC/Setup/temp_names[1]",
        "/PixelQC/Setup/temp_channel[0]",
        "/PixelQC/Setup/temp_channel[1]",
        "/PixelQC/Flags/stream"
    ]).then(rpc => {
        const data = rpc.result.data;

        // US configuration
        equipmentConfig.US.lv_name = data[0];
        equipmentConfig.US.lv_channel = Number(data[2]);
        equipmentConfig.US.hv_name = data[4];
        equipmentConfig.US.hv_channel = Number(data[6]);
        equipmentConfig.US.temp_name = data[8];
        equipmentConfig.US.temp_channel = Number(data[10]);

        // DS configuration
        equipmentConfig.DS.lv_name = data[1];
        equipmentConfig.DS.lv_channel = Number(data[3]);
        equipmentConfig.DS.hv_name = data[5];
        equipmentConfig.DS.hv_channel = Number(data[7]);
        equipmentConfig.DS.temp_name = data[9];
        equipmentConfig.DS.temp_channel = Number(data[11]);

        // Stream mode
        currentStream = data[12] || "both_sided";

        console.log("Equipment config loaded:", equipmentConfig);
        console.log("Stream mode:", currentStream);

        // Create dynamic ODB watchers
        createMonitoringWatchers();

        // Update visibility based on stream
        updateStreamVisibility(currentStream);

        return equipmentConfig;
    }).catch(err => {
        console.error("loadEquipmentConfig error:", err);
    });
}

// Create dynamic ODB watchers for monitoring based on equipment configuration
function createMonitoringWatchers() {
    const container = document.getElementById('monitoring-watchers');
    if (!container) {
        console.error("monitoring-watchers container not found!");
        return;
    }

    // Clear existing watchers
    container.innerHTML = '';

    // Helper to create watcher div
    const createWatcher = (path, onchangeHandler) => {
        const div = document.createElement('div');
        div.className = 'modb';
        div.setAttribute('data-odb-path', path);
        if (onchangeHandler) {
            div.setAttribute('onchange', onchangeHandler);
        }
        div.style.display = 'none';
        container.appendChild(div);
    };

    // US Power Supply Monitoring
    createWatcher(`${equipmentConfig.US.lv_name}/Variables/Current[${equipmentConfig.US.lv_channel}]`, 'updateLVCurrent(this.value, false);');
    createWatcher(`${equipmentConfig.US.lv_name}/Variables/Voltage[${equipmentConfig.US.lv_channel}]`, 'updateLVVoltage(this.value, false);');
    createWatcher(`${equipmentConfig.US.lv_name}/Variables/State[${equipmentConfig.US.lv_channel}]`, 'updateLVState(this.value, false)');
    createWatcher(`${equipmentConfig.US.lv_name}/Variables/Current Limit[${equipmentConfig.US.lv_channel}]`, 'updateLVCurrentLimit(this.value, false)');

    createWatcher(`${equipmentConfig.US.hv_name}/Variables/State[${equipmentConfig.US.hv_channel}]`, 'updateHVState(this.value, false)');
    createWatcher(`${equipmentConfig.US.hv_name}/Variables/Voltage[${equipmentConfig.US.hv_channel}]`);
    createWatcher(`${equipmentConfig.US.hv_name}/Variables/Current[${equipmentConfig.US.hv_channel}]`, 'updateHVCurrent(this.value, false)');
    createWatcher(`${equipmentConfig.US.hv_name}/Variables/Current Limit[${equipmentConfig.US.hv_channel}]`, 'updateHVCurrentLimit(this.value, false)');

    // DS Power Supply Monitoring
    createWatcher(`${equipmentConfig.DS.lv_name}/Variables/Current[${equipmentConfig.DS.lv_channel}]`, 'updateLVCurrent(this.value, true);');
    createWatcher(`${equipmentConfig.DS.lv_name}/Variables/Voltage[${equipmentConfig.DS.lv_channel}]`, 'updateLVVoltage(this.value, true);');
    createWatcher(`${equipmentConfig.DS.lv_name}/Variables/State[${equipmentConfig.DS.lv_channel}]`, 'updateLVState(this.value, true)');
    createWatcher(`${equipmentConfig.DS.lv_name}/Variables/Current Limit[${equipmentConfig.DS.lv_channel}]`, 'updateLVCurrentLimit(this.value, true)');

    createWatcher(`${equipmentConfig.DS.hv_name}/Variables/State[${equipmentConfig.DS.hv_channel}]`, 'updateHVState(this.value, true)');
    createWatcher(`${equipmentConfig.DS.hv_name}/Variables/Voltage[${equipmentConfig.DS.hv_channel}]`);
    createWatcher(`${equipmentConfig.DS.hv_name}/Variables/Current[${equipmentConfig.DS.hv_channel}]`, 'updateHVCurrent(this.value, true)');
    createWatcher(`${equipmentConfig.DS.hv_name}/Variables/Current Limit[${equipmentConfig.DS.hv_channel}]`, 'updateHVCurrentLimit(this.value, true)');

    // Temperature Monitoring
    createWatcher(`${equipmentConfig.US.temp_name}/Variables/Temperature[${equipmentConfig.US.temp_channel}]`, 'updateTemperature(this.value, false);');
    createWatcher(`${equipmentConfig.DS.temp_name}/Variables/Temperature[${equipmentConfig.DS.temp_channel}]`, 'updateTemperature(this.value, true);');

    // ASIC Mask auto-update watchers
    createWatcher('/PixelQC/Dut/DUT', 'updateASICMask();');
    createWatcher('/PixelQC/Dut/N_chips', 'updateASICMask();');
    createWatcher('/PixelQC/Flags/stream', 'updateASICMask();');
    createWatcher('/PixelQC/Setup', 'updateASICMask();');

    console.log("Dynamic monitoring watchers created");
}

// Update visibility of US/DS columns and rows based on stream mode
function updateStreamVisibility(stream) {
    currentStream = stream || currentStream;
    console.log("Updating stream visibility to:", currentStream);

    const showUS = (currentStream === "US" || currentStream === "both_sided");
    const showDS = (currentStream === "DS" || currentStream === "both_sided");
    // Prefer class-based toggling: elements with class 'us' / 'ds' will be shown/hidden.
    // This allows a single loop in the HTML to tag elements accordingly.
    const usEls = document.querySelectorAll('.us');
    const dsEls = document.querySelectorAll('.ds');

    if (usEls.length > 0 || dsEls.length > 0) {
        usEls.forEach(el => {
            el.style.display = showUS ? '' : 'none';
            // preserve behavior for interactive regions: toggle name="modb" when shown
            if (el.classList.contains('modb-region')) {
                if (showUS) el.setAttribute('name', 'modb');
                else el.removeAttribute('name');
            }
        });
        dsEls.forEach(el => {
            el.style.display = showDS ? '' : 'none';
            if (el.classList.contains('modb-region')) {
                if (showDS) el.setAttribute('name', 'modb');
                else el.removeAttribute('name');
            }
        });
        return; // done via classes
    }

    // Fallback: legacy ID-based logic (keeps existing behavior if classes aren't present yet)
    const monitoringTable = document.getElementById("chip_monitoring");
    if (monitoringTable) {
        const rows = monitoringTable.querySelectorAll('tr');
        rows.forEach(row => {
            const cells = row.querySelectorAll('td, th');
            if (cells.length >= 3) {
                if (cells[1]) cells[1].style.display = showUS ? '' : 'none';
                if (cells[2]) cells[2].style.display = showDS ? '' : 'none';
            }
        });
    }

    // HV table rows fallback
    const hvTable = document.getElementById("HVSUPPLY0");
    if (hvTable) {
        const usRow = hvTable.querySelector('#us_header')?.closest('tr');
        const dsRow = hvTable.querySelector('#ds_header')?.closest('tr');
        if (usRow) usRow.style.display = showUS ? '' : 'none';
        if (dsRow) dsRow.style.display = showDS ? '' : 'none';
    }

    // Temperature diode rows fallback
    const tempTable = document.getElementById("TEMPDIODEs");
    if (tempTable) {
        const usRow = tempTable.querySelector('.tempdiode0-row');
        const dsRow = tempTable.querySelector('.tempdiode1-row');
        if (usRow) usRow.style.display = showUS ? '' : 'none';
        if (dsRow) dsRow.style.display = showDS ? '' : 'none';
    }

    // container fallbacks
    const usDiv = document.getElementById("container_US");
    const dsDiv = document.getElementById("container_DS");
    if (usDiv) usDiv.style.display = showUS ? 'inline-block' : 'none';
    if (dsDiv) dsDiv.style.display = showDS ? 'inline-block' : 'none';
}

//initialize all monitoring values
function initMonitoring() {
    // First load equipment configuration
    loadEquipmentConfig().then(() => {
        // Build dynamic ODB paths based on equipment configuration
        const odbPaths = [
            "/PixelQC/Setup/homeFolder",
            "/PixelQC/Dut/PartNumber",
            // US LV
            `${equipmentConfig.US.lv_name}/Variables/State[${equipmentConfig.US.lv_channel}]`,
            `${equipmentConfig.US.lv_name}/Variables/Voltage[${equipmentConfig.US.lv_channel}]`,
            `${equipmentConfig.US.lv_name}/Variables/Current[${equipmentConfig.US.lv_channel}]`,
            `${equipmentConfig.US.lv_name}/Variables/Current Limit[${equipmentConfig.US.lv_channel}]`,
            // US HV
            `${equipmentConfig.US.hv_name}/Variables/State[${equipmentConfig.US.hv_channel}]`,
            `${equipmentConfig.US.hv_name}/Variables/Voltage[${equipmentConfig.US.hv_channel}]`,
            `${equipmentConfig.US.hv_name}/Variables/Current[${equipmentConfig.US.hv_channel}]`,
            `${equipmentConfig.US.hv_name}/Variables/Current Limit[${equipmentConfig.US.hv_channel}]`,
            // DS LV
            `${equipmentConfig.DS.lv_name}/Variables/State[${equipmentConfig.DS.lv_channel}]`,
            `${equipmentConfig.DS.lv_name}/Variables/Voltage[${equipmentConfig.DS.lv_channel}]`,
            `${equipmentConfig.DS.lv_name}/Variables/Current[${equipmentConfig.DS.lv_channel}]`,
            `${equipmentConfig.DS.lv_name}/Variables/Current Limit[${equipmentConfig.DS.lv_channel}]`,
            // DS HV
            `${equipmentConfig.DS.hv_name}/Variables/State[${equipmentConfig.DS.hv_channel}]`,
            `${equipmentConfig.DS.hv_name}/Variables/Voltage[${equipmentConfig.DS.hv_channel}]`,
            `${equipmentConfig.DS.hv_name}/Variables/Current[${equipmentConfig.DS.hv_channel}]`,
            `${equipmentConfig.DS.hv_name}/Variables/Current Limit[${equipmentConfig.DS.hv_channel}]`,
            // Temperature
            `${equipmentConfig.US.temp_name}/Variables/Temperature[${equipmentConfig.US.temp_channel}]`,
            `${equipmentConfig.DS.temp_name}/Variables/Temperature[${equipmentConfig.DS.temp_channel}]`
        ];

        return mjsonrpc_db_get_values(odbPaths).then(rpc => {
            const data = rpc.result.data;

            // Legacy variables
            homeFolder = data[0];
            partNumberInit = data[1];

            // Initialize US monitoring state
            monitoringState.US.LVon = Boolean(data[2]);
            monitoringState.US.LVvoltage = Number(data[3]);
            monitoringState.US.LVcurrent = Number(data[4]);
            monitoringState.US.LVlimit = Number(data[5]);
            monitoringState.US.HVon = Boolean(data[6]);
            monitoringState.US.HVlimit = Number(data[9]) * 1e6;

            // Initialize DS monitoring state
            monitoringState.DS.LVon = Boolean(data[10]);
            monitoringState.DS.LVvoltage = Number(data[11]);
            monitoringState.DS.LVcurrent = Number(data[12]);
            monitoringState.DS.LVlimit = Number(data[13]);
            monitoringState.DS.HVon = Boolean(data[14]);
            monitoringState.DS.HVlimit = Number(data[17]) * 1e6;

            // Initialize displays
            updateLVState(data[2], false);
            updateHVState(data[6], false);
            updateLVCurrent(data[4], false);
            updateHVCurrent(data[8], false);

            updateLVState(data[10], true);
            updateHVState(data[14], true);
            updateLVCurrent(data[12], true);
            updateHVCurrent(data[16], true);

            // Temperature
            if (data[18] !== null) updateTemperature(data[18], false);
            if (data[19] !== null) updateTemperature(data[19], true);

            updateChipType(0, partNumberInit);
            UpdateChipToRead();
            updateCheckboxState();
        });
    }).catch(err => {
        console.error("initMonitoring error:", err);
    });
}
initMonitoring(); //loaded in the beginning
setInterval(updateCheckboxState, 1000);


function Ta5000_visibility() {
  mjsonrpc_db_get_value("/PixelQC/Setup/Setup").then(rpc => {
    const setupName = rpc.result.data[0];
    const table = document.getElementById("Thermal_Air"); // hide the full table instead of the row

    if (!table) return;
    if (setupName === "OxQC43") {
      table.style.display = "";   // show everything
    } else {
      table.style.display = "none"; // hide whole panel
    }
  }).catch(err => console.error("ODB fetch failed:", err));
}

// Run once on load
document.addEventListener("DOMContentLoaded", Ta5000_visibility);

// Optionally recheck every few seconds
setInterval(Ta5000_visibility, 5000);



// TS and LV this can be removed right?
function UpdateChipToRead(){

    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
        const dut = rpc.result.data[0];
        mjsonrpc_db_get_values(["/PixelQC/Flags/stream","/Equipment/PixelsCentral/Commands/MupixChipToConfigure","/Equipment/PixelsCentral/QC/FEBlink"]).then(rpc => {
            const stream = rpc.result.data[0];
            const chip_number = rpc.result.data[1];
            const feblink = rpc.result.data[2];
        if (dut =="ladder_inner" && stream == "DS")
            {
                if (chip_number - feblink / 3 == 0){
                    modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", chip_number + 2);
                }
                else if ((chip_number - feblink / 3 == 2)){
                    modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", chip_number - 2)
                }
                else if (chip_number==999){
                    modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", 0)}
                else{
                    modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", chip_number)}
            }
            else if (chip_number==999){
                modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", 0)}
            else{
                modbset("/Equipment/PixelsCentral/Commands/QcHisto chip number", chip_number)}
        })

    })
}



function updateChipType(howImport,input) {
    let PN;
    if (howImport == 1) { PN = input; }
    if (howImport == 0) { PN = input; }
    // var checkbox = document.getElementById("IsMuPix11");
    var checkbox2 = document.getElementById("invertSIN");
    var messageMPtype = document.getElementById("chipMPtype");
    var messageThickness = document.getElementById("chipThickness");
    var messageResistivity = document.getElementById("chipResistivity");

    messageMPtype.textContent = PN;

    chipPNs = ["MuPix11_PNs", "MuPix10_PNs", "MP11_VD_ladder_PNs","MP11_VD_module_L1_PNs","MP11_L4_ladder_PNs","MP11_L3_ladder_PNs","MP11_L4_module_PNs","MP11_L3_module_PNs"];
    chipNames = ["MuPix11", "MuPix10", "MP11 VD Ladder","MP11 VD Module L1","MP11 Central Ladder L4","MP11 Central Ladder L3","MP11 L4 Module","MP11 L3 Module"];
    chipThicknesses = ["MuPix11_thickness", "MuPix10_thickness", "MP11_VD_ladder_thickness","MP11_VD_module_L1_thickness","MP11_L4_ladder_thickness","MP11_L3_ladder_thickness","MP11_L4_module_thickness","MP11_L3_module_thickness"];
    chipResistivities = ["MuPix11_resistivity", "MuPix10_resistivity", "MP11_VD_ladder_resistivity","MP11_VD_module_L1_resistivity","MP11_L4_ladder_resistivity","MP11_L3_ladder_resistivity","MP11_L4_module_resistivity","MP11_L3_module_resistivity"];

    for (var i = 0; i < chipPNs.length; ++i) {
        for (var j = 0; j < Chip_types[chipPNs[i]].length; ++j) {
            // MP11 single chips
            if (PN == Chip_types[chipPNs[i]][j] && i == 0 ) { //MP11 --> i==0
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != true) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "chip");
                modbset("/PixelQC/Dut/N_chips", 1);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 3);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", true);
                modbset("/Equipment/LinksCentral/Settings/LVDSLinkInvert[0]",3407872);
            }
            // MP10 single chips
            if (PN == Chip_types[chipPNs[i]][j] && i == 1) { //MP10 --> i==1
                // if (checkbox.checked != false) { checkbox.click(); }
                if (checkbox2.checked != true) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "chip");
                modbset("/PixelQC/Dut/N_chips", 1);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 3);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
            }
            // VD ladders, so far only MP11
            if (PN == Chip_types[chipPNs[i]][j] && i == 2 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "ladder_inner");
                modbset("/PixelQC/Dut/N_chips", 3);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 3);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
            }
            if (PN == Chip_types[chipPNs[i]][j] && i == 3 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "module_L1");
                modbset("/PixelQC/Dut/N_chips", 12);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 3);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
            }
            if (PN == Chip_types[chipPNs[i]][j] && i == 4 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "outer_ladder_L4");
                modbset("/PixelQC/Dut/N_chips", 9);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 1);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
            }
            if (PN == Chip_types[chipPNs[i]][j] && i == 5 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "outer_ladder_L3");
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
                mjsonrpc_db_get_values(["/PixelQC/Flags/stream"]).then(rpc => {
                    const stream = rpc.result.data[0];
                    modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 1);
                    if (stream == "DS"){
                        modbset("/PixelQC/Dut/N_chips", 8);}
		    else {
                        modbset("/PixelQC/Dut/N_chips", 9);}
                    })
            }
            if (PN == Chip_types[chipPNs[i]][j] && i == 6 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "outer_module_L4");
                modbset("/PixelQC/Dut/N_chips", 36);
                modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 1);
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
            }
            if (PN == Chip_types[chipPNs[i]][j] && i == 7 ) { //MP11 ladder --> i==2
                // if (checkbox.checked != true) { checkbox.click(); }
                if (checkbox2.checked != false) { checkbox2.click(); }
                messageMPtype.textContent = chipNames[i];
                messageThickness.textContent = Chip_types[chipThicknesses[i]][j];
                messageResistivity.textContent = Chip_types[chipResistivities[i]][j];
                modbset("/PixelQC/Dut/DUT", "outer_module_L3");
                var Thicky = parseInt(Chip_types[chipThicknesses[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipThickness", Thicky);
                var Resy = parseInt(Chip_types[chipResistivities[i]][j].match(/\d+/)[0]);
                modbset("/PixelQC/Dut/ChipResistivity", Resy);
                modbset("/Equipment/PixelsCentral/Commands/InvertSerialIn", false);
                mjsonrpc_db_get_values(["/PixelQC/Flags/stream"]).then(rpc => {
                    const stream = rpc.result.data[0];
                    modbset("/Equipment/PixelsCentral/Commands/N_Links_per_chip", 1);
                    if (stream == "US"){
                        modbset("/PixelQC/Dut/N_chips", 36);}
                    else{
                        modbset("/PixelQC/Dut/N_chips", 32);}
                    })
            }

        }
    }
}
//remove part of the general settings if it is a chip. Not necessary for chip operation or should be fixed.
function remove_if_chip(){
    let table = document.getElementById('config pars');
    const removeRows = (className) => {
        let rows = table.getElementsByClassName(className);
        Array.from(rows).forEach(row => {row.parentNode.removeChild(row);});};
    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
    const dut = rpc.result.data[0];
        if(dut == "chip"){
            removeRows('setting-lv');
            removeRows('setting-Nchips');
            removeRows('setting-feblink');
            removeRows('setting-us');
        }
    })
}
remove_if_chip()
//---------------------------------

//Defines how many digits of a value will be displayed
function precise(x, prec) {
    return Number.parseFloat(x).toPrecision(prec);
}

//---------------
function sleep_ms(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function SwitchOffOtherChips(){

    for (let chip = 0; chip < 12; ++chip) {
        await modbset(`/Equipment/PixelsCentral/Settings/BIASDACS/${chip}/BiasBlock_on`, 0);
    }

    // Get the chip number
    const rpc = await mjsonrpc_db_get_values(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"]);
    let chip_number = rpc.result.data[0]; // Changed from const to let

    // Default chip number to 0 if it is 999
    if (chip_number === 999) {
        chip_number = 0;
    }

    // Configure the specified chip
    await modbset(`/Equipment/PixelsCentral/Settings/BIASDACS/${chip_number}/BiasBlock_on`, 5);
    await modbset(`/Equipment/PixelsCentral/Commands/MupixChipToConfigure`, 999);

    // Wait for 1 second
    await sleep_ms(1000);

    // Complete configuration
    await mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixConfig"], [true]);
    await modbset(`/Equipment/PixelsCentral/Commands/MupixChipToConfigure`, chip_number);
}

function adc_vars() {
    const name_paths = [
        "/Equipment/PixelQCADC/Settings/Names Input",
        "/Equipment/Senseadc0/Settings/Names Voltage"
    ];

    const value_base_paths = [
        "/Equipment/PixelQCADC/Variables/Input",
        "/Equipment/Senseadc0/Variables/Voltage"
    ];

    // Try the first available path
    mjsonrpc_db_get_values(name_paths).then(rpc => {
        let adc_vars = rpc.result.data.find(e => e !== null);
        let base_index = rpc.result.data.findIndex(e => e !== null);

        if (!adc_vars || base_index === -1) {
            console.warn("No ADC names found.");
            return;
        }

        const base_path = value_base_paths[base_index];
        const table = document.getElementById("ADCs");
        table.style.display = "inline-block";

        for (let adc = 0; adc < adc_vars.length; ++adc) {
            let row = table.insertRow(-1);
            let cell1 = row.insertCell(0);
            let cell2 = row.insertCell(1);

            cell1.textContent = adc_vars[adc];
            cell2.classList.add("modbvalue");

            let link = `${base_path}[${adc}]`;
            cell2.setAttribute("data-odb-path", link);
            cell2.setAttribute("data-format", "f3");

            const cell_id = `adc_read_${adc}`;
            cell2.id = cell_id;

            // Temperature callback on specific ADC (e.g., index 2)
            if (adc === 2) {
                cell2.addEventListener("DOMSubtreeModified", function () {
                    document.getElementById("monit_temperature").innerHTML =
                        convert_v_to_temperature(this.textContent).toFixed(2);
                });
            }
        }
    });
}

adc_vars();

//only show the temp diode if not chip and if available in the odb
function check_tempdiode() {
    let table = document.getElementById('TEMPDIODEs');
    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
        const dut = rpc.result.data[0];
    if(dut != "chip"){
    mjsonrpc_db_get_values(["/Equipment/TEMPDIODE0/Variables/State", "/Equipment/TEMPDIODE0/Variables/State"]).then(rpc => {
        if (rpc && rpc.result && rpc.result.data) {
            const tempdiode0Exists = rpc.result.data[0];
            const tempdiode1Exists = rpc.result.data[1];
            const removeRows = (className) => {
                let rows = table.getElementsByClassName(className);
                Array.from(rows).forEach(row => {
                    row.parentNode.removeChild(row);
                });
            };
                if (!tempdiode0Exists && !tempdiode0Exists){
                    table.parentNode.removeChild(table);
                }
                else{
                    if (!tempdiode0Exists) {
                        removeRows('tempdiode0-row');
                    }
                    if (!tempdiode1Exists) {
                        removeRows('tempdiode1-row');
                    }
                }
        }
        else {
            console.error('Unexpected RPC response structure:', rpc);
        }
    }).catch(error => {
        console.error('RPC call failed:', error);
    });}
    else{
        table.parentNode.removeChild(table);
    }
})
}

check_tempdiode();
//check if arduino is available otherwise do not show
function check_arduino(){
    let table = document.getElementById('ArduinoAdc');
    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
        const dut = rpc.result.data[0];
    if(dut!="chip"){
        mjsonrpc_db_get_values(["/Equipment/ArduinoSenseADC/Variables/Voltage"]).then(rpc => {
            const arduino_adc_exist = rpc.result.data[0];
            if (!arduino_adc_exist){
                table.parentNode.removeChild(table);
            }
        });
    }
    else{
        table.parentNode.removeChild(table);
    }
})
}
check_arduino()


function check_hv(){
    let table = document.getElementById('hv_row');
    const usHeader = document.getElementById('us_header');
    mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
    const dut = rpc.result.data[0];
    if(dut == "chip"){
        table.parentNode.removeChild(table);
        usHeader.textContent = 'Chip';}
    else{
        mjsonrpc_db_get_values(["/Equipment/HVSUPPLY1/Variables/OVP Level[0]"]).then(rpc => {
            const hv1_exist = rpc.result.data[0];
            if (!hv1_exist){
                table.parentNode.removeChild(table);
            }
        });
    }
})
}
check_hv()

async function update_sequencer_vals_to_default() {
    try {
        const rpc = await mjsonrpc_db_get_values(["/PySequencer/Param/Defaults"]);
        const def_vals = rpc.result.data[0];

        const var_list = [];
        const val_list = [];


        for (const [key, value] of Object.entries(def_vals)) {
            if (key.includes("/key")) {
                continue;
            }
            const var_name = "/PySequencer/Param/Value/" + key;
            var_list.push(var_name);
            val_list.push(value);
        }
        const rpc2 = await mjsonrpc_db_paste(var_list, val_list);
        // Handle rpc2 if needed
    } catch (error) {
        console.log(error);
    }
}


function show_qc_column (qcTest) {
    var column = document.getElementById(qcTest);
    column.style["display"] = 'block'
    if (qcTest == "qc_column_full")
        document.getElementById("qc-extra-comments").style["display"] = 'inline-block'
    /*dlgAlert("")*/
}

function hide_qc_column (qcTest) {
    /*var column = document.getElementsByClassName(qcTest);*/
    var qccols = document.getElementsByClassName(qcTest);
    for (var i = 0; i < qccols.length; i ++) {
        qccols[i].style.display='none';
    }
    if (qcTest == "qc_column_full")
        document.getElementById("qc-extra-comments").style["display"] = 'none'
}

//setup_listeners();

disperr_last = []
hits_last = []
berr_last = []
for (var i = 0; i < 4; ++i) {
    disperr_last.push(0);
    hits_last.push(0);
    berr_last.push(0);
}
setInterval(update_masked_links, 100);

async function update_masked_links() {
  try {
    const rpc = await mjsonrpc_db_get_values([
      "/Equipment/LinksCentral/Settings/LVDSLinkMask[0]"
    ]);
    let mask = Number(rpc.result.data[0]); // als Integer

    const zeroPositions = [];
    for (let i = 0; i < 36; i++) {
      const bit = (mask >> i) & 1;
      if (bit === 0) {
        zeroPositions.push(i);
      }
    }

    const zeroPositionsString = zeroPositions.length > 0 ? zeroPositions.join(",") : "None";

    await mjsonrpc_db_paste(
      ["/PixelQC/Monitoring/MaskedLinks"],
      [zeroPositionsString]
    );

  } catch (e) {
    console.error("update_masked_links failed:", e);
  }
}

function noise_scan_update_chip_number_sw () {
    mjsonrpc_db_get_values(["/Equipment/SwitchingCentral/Commands/MupixChipToConfigure"]).then(rpc => {
        let chip_number = rpc.result.data[0];
        if (chip_number == 999){
            chip_number = 0
        }
    let mask_file = document.getElementById("noise_scan_mask_file")
    mask_file.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/TDACFILE" )
    let hitmap_file = document.getElementById("noise_scan_hitmap_file")
    hitmap_file.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/HITMAPFILE" )
    let threshold = document.getElementById("noise_scan_threshold")
    threshold.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/VDACS/" + chip_number.toString() + "/ThHigh" )
    let threshold_low = document.getElementById("noise_scan_threshold_low")
    threshold_low.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/VDACS/" + chip_number.toString() + "/ThLow" )
    let threshold_vpdac = document.getElementById("noise_scan_vpdac")
    threshold_vpdac.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/BIASDACS/" + chip_number.toString() + "/VPDAC" )
 })
}

function makeASICMask(feblink, length) {
  const ones = Math.pow(2, length) - 1;      // (2^length) - 1
  return ones * Math.pow(2, feblink);        // nach links "schieben"
}

// Write a single ASICMask word for a given FEB index, without rebuild.
// Returns true if a write occurred (value changed), else false.
async function writeAsicMask(febIdx, maskValue, currentMask) {
  if (maskValue === currentMask) {
    return false;   // No change needed
  }
  await mjsonrpc_db_paste([`/Equipment/LinksCentral/Settings/ASICMask[${febIdx}]`], [maskValue]);
  return true;
}

// Trigger rebuild after all needed writes
async function rebuildAsicMasks() {
  await mjsonrpc_db_paste(["/Equipment/LinksCentral/Settings/Rebuild"], [true]);
}

async function updateASICMask() {
  const rpc = await mjsonrpc_db_get_values([
    "/PixelQC/Dut/DUT",
    "/Equipment/LinksCentral/Settings/ASICMask",
    "/PixelQC/Dut/N_chips",
    "/PixelQC/Flags/stream",
    "/PixelQC/Setup"
  ]);

  const dut      = rpc.result.data[0];
  const maskArr  = Array.isArray(rpc.result.data[1]) ? rpc.result.data[1] : [];
  const n_chips  = Number(rpc.result.data[2]);
  const stream   = rpc.result.data[3]; // "US" | "DS" | "both_sided"
  const setup    = rpc.result.data[4] || {};

  const streams = setup.streams  || [];
  const febs    = setup.feb      || [];
  const feb_pos = setup.feb_pos  || [];

  const idxUS = streams.indexOf("US");
  const idxDS = streams.indexOf("DS");

  // preserve real zeros; fall back to 0 only if value truly missing
  const febUSPos = Number((idxUS >= 0 ? feb_pos[idxUS] : 0)) * n_chips;
  const febDSPos = Number((idxDS >= 0 ? feb_pos[idxDS] : 0)) * n_chips;

  // Map stream slot -> FEB index in ASICMask array (not necessarily 0/1)
  const febUSIdx = Number(idxUS >= 0 ? (febs[idxUS] ?? 0) : 0);
  const febDSIdx = Number(idxDS >= 0 ? (febs[idxDS] ?? 0) : 0);

  const currentUS = Number(maskArr[febUSIdx] ?? 0);
  const currentDS = Number(maskArr[febDSIdx] ?? 0);

  // Chip DUT: let generic logic below handle it; no special hard-coded slot
  // Do we really need this code below, if the user only wants to select certain chips, the code below will interfere and reactivate all again!

  //let updated = false;
  //if (stream === "both_sided") {
    //const maskUS = makeASICMask(febUSPos, n_chips);
    //const maskDS = makeASICMask(febDSPos, n_chips);
    // Write to each FEB index independently
    //if (idxUS >= 0) {
      //updated = (await writeAsicMask(febUSIdx, maskUS, currentUS)) || updated;
    //}
    //if (idxDS >= 0) {
      //updated = (await writeAsicMask(febDSIdx, maskDS, currentDS)) || updated;
    //}
  //} else if (stream === "US") {
    //if (!(idxUS >= 0)) { console.warn('Stream "US" not found in setup.streams'); return; }
    //const maskUS = makeASICMask(febUSPos, n_chips);
    //updated = await writeAsicMask(febUSIdx, maskUS, currentUS);
  //} else if (stream === "DS") {
    //if (!(idxDS >= 0)) { console.warn('Stream "DS" not found in setup.streams'); return; }
    //const maskDS = makeASICMask(febDSPos, n_chips);
    //updated = await writeAsicMask(febDSIdx, maskDS, currentDS);
  //} else {
    //console.warn(`Unknown stream "${stream}"`);
  //}

  //if (updated) {
    //await rebuildAsicMasks();
    //console.log("ASIC mask rebuilt")
  //}
}




function sleep(s){ return new Promise(r=>setTimeout(r,s*1000)); }

// Lies alle 36 PCLS-Werte in einem RPC
async function readPCLSBatch() {
  const base = "/Equipment/PixelsCentral/Variables/PCLS";
  const paths = [];
  for (let i=0;i<36;i++) paths.push(`${base}[${4+4*i}]`);
  const rpc = await mjsonrpc_db_get_values(paths);
  return rpc.result.data.map(v => Number(v) || 0);
}

// Rechne diff / dt mit Rollover-Schutz
function ratesFromCounters(c1, c2, dt, modulus = 2**32) {
  const rates = new Array(c1.length);
  for (let i=0;i<c1.length;i++){
    let diff = c2[i] - c1[i];
    if (diff < 0) diff += modulus;      // Rollover
    rates[i] = diff / dt;
  }
  return rates;
}

// Baue Maske: rate>thresh → Bit=0, sonst 1 (LSB=Link0)
function maskFromRates(rates, threshold) {
  let mask = 0;
  for (let i=0;i<rates.length;i++){
    if (rates[i] <= threshold) mask |= (1<<i);
  }
  return mask >>> 0;
}

// Eine stabile Messung mit Batch-Reads
async function measureMaskOnce(waitSeconds=5, threshold=1000, modulus=2**32) {
  const c1 = await readPCLSBatch();
  await sleep(waitSeconds);
  const c2 = await readPCLSBatch();
  const rates = ratesFromCounters(c1, c2, waitSeconds, modulus);
  return { rates, mask: maskFromRates(rates, threshold) };
}

// Optional: 3 Messungen → Median je Link (stabiler)
function median(a,b,c){ return [a,b,c].sort((x,y)=>x-y)[1]; }

async function measureMaskMedian(waitSeconds=5, threshold=1000, modulus=2**32) {
  const m1 = await measureMaskOnce(waitSeconds, threshold, modulus);
  const m2 = await measureMaskOnce(waitSeconds, threshold, modulus);
  const m3 = await measureMaskOnce(waitSeconds, threshold, modulus);

  const ratesMed = m1.rates.map((_,i)=>median(m1.rates[i], m2.rates[i], m3.rates[i]));
  const mask = maskFromRates(ratesMed, threshold);
  return { rates: ratesMed, mask };
}

async function runMask() {
  try {
    // schnellere, aber stabilere Option als vorher:
    // const { mask } = await measureMaskOnce(5, 1000);

    // noch stabiler (median aus 3 Messungen):
    const { mask } = await measureMaskMedian(2, 1000); // 3×2s statt einmal 5s

    await mjsonrpc_db_paste(
      ["/Equipment/LinksCentral/Settings/LVDSLinkMask[0]"],
      [mask]
    );
    alert(`LVDSLinkMask gesetzt: ${mask}`);
  } catch (e) {
    console.error(e);
    alert("Fehler – Details in Konsole");
  }
}



const LINK_STRIDE = 4;
const N_LINKS     = 36;

let disperr_last_US = Array(N_LINKS).fill(0);
let berr_last_US    = Array(N_LINKS).fill(0);
let hits_last_US    = Array(N_LINKS).fill(0);
let disperr_last_DS = Array(N_LINKS).fill(0);
let berr_last_DS    = Array(N_LINKS).fill(0);
let hits_last_DS    = Array(N_LINKS).fill(0);
function callHelpers() {
  try {
    UpdateChipToRead?.();
    update_masked_links?.();
    noise_scan_update_chip_number_sw?.();
    updateCheckboxState?.();
    updateErrorcounter?.();
  } catch (_) {}
}

function applyUSDSVisibility() {
  mjsonrpc_db_get_values([
    "/PixelQC/Dut/DUT",
    "/PixelQC/Flags/stream"
  ]).then(rpc => {
    const dut  = String(rpc.result?.data?.[0] || "").toLowerCase();
    const mode = String(rpc.result?.data?.[1] || "US").toUpperCase();

    const usDiv = document.getElementById("container_US");
    const dsDiv = document.getElementById("container_DS");

    const setActive = (el, active) => {
      if (!el) return;
      el.style.display = active ? "inline-block" : "none";
      if (active) el.setAttribute("name", "modb");
      else        el.setAttribute("name", "");
    };

    // For chip DUT, only show the selected stream
    if (dut === "chip") {
      setActive(usDiv, mode === "US");
      setActive(dsDiv, mode === "DS");
      return;
    }

    // For other DUTs, follow the stream mode
    if (mode === "BOTH_SIDED") {
      setActive(usDiv, true);
      setActive(dsDiv, true);
    } else if (mode === "DS") {
      setActive(usDiv, false);
      setActive(dsDiv, true);
    } else { // "US"
      setActive(usDiv, true);
      setActive(dsDiv, false);
    }
  });
}
function applyChipLayout(side, offset, dut) {
  const isChip = String(dut).toLowerCase() === "chip";
  const suffix = (side === "US") ? "" : "_DS";
  for (let x = 0; x <= 8; x++) {
    const cell = document.getElementById(`cell${x}${suffix}`);
    if (!cell) continue;
    const row = cell.closest("tr");
    if (!row) continue;

    if (isChip) {
      if (x <= 2) {
        row.style.display = "";
        cell.textContent = x; // labels 0,1,2 (no offset in chip mode)
      } else if (x === 3) {
        row.style.display = "";
        cell.textContent = 13; // label 13 (no offset in chip mode)
      } else {
        row.style.display = "none";
      }
    } else {
      row.style.display = "";
      cell.textContent = x + offset; // module mode: 0..8 + offset
    }
  }
}

async function update_pcls_US(valuex) {
  if (typeof callHelpers === "function") callHelpers(); // run heavy UI helpers once here

  const value = (typeof valuex === "string") ? JSON.parse(valuex) : valuex;
  if (!Array.isArray(value)) return;

  // DUT und Setup lesen
  const rpc = await mjsonrpc_db_get_values([
    "/PixelQC/Dut/DUT",
    "/PixelQC/Setup"
  ]);

  const dutRaw = rpc?.result?.data?.[0];
  const dut = String(dutRaw ?? "").toLowerCase();

  const setup = rpc?.result?.data?.[1] ?? {};
  const streams = Array.isArray(setup.streams) ? setup.streams : [];
  const feb     = setup.feb     ?? [];
  const feb_pos = setup.feb_pos ?? [];

  // US-Index finden
  const US = streams.indexOf("US");
  if (US < 0) {
    console.warn('Stream "US" not found in setup.streams:', streams);
    return;
  }

  // Support both array and object shapes for feb/feb_pos
  const pickByIndex = (src, idx) => {
    if (Array.isArray(src)) return Number(src[idx] ?? 0);
    if (src && typeof src === "object") {
      const key = streams[idx];
      return Number(src[key] ?? 0);
    }
    return 0;
  };

  const isChipOrInner = ["chip", "ladder_inner"].includes(dut);
  const maxChips = isChipOrInner ? 12 : 36;
  const isChip = (dut === "chip");

  let usFebList;
  let usFebPosList;

  if (Array.isArray(feb))
  {
    // one FEB per stream → only ONE US FEB exists
    usFebList = [ pickByIndex(feb, US) ];
    usFebPosList = [ pickByIndex(feb_pos, US) ];
  }
  else
  {
    // object keyed by stream → multiple FEBs per stream
    usFebList = Array.isArray(feb.US) ? feb.US : [];
    usFebPosList = Array.isArray(feb_pos.US) ? feb_pos.US : [];
  }


  // Layout/Visibility anwenden
  if (typeof applyUSDSVisibility === "function") applyUSDSVisibility();
  if (typeof applyChipLayout === "function")     applyChipLayout("US", 0, dut);

  let rowOffset = 0;

  // Rolling-Diff Speicher vorbereiten (global erwartet)
    window.disperr_last_US = Array.isArray(window.disperr_last_US) ? window.disperr_last_US : [];
    window.berr_last_US    = Array.isArray(window.berr_last_US)    ? window.berr_last_US    : [];
    window.hits_last_US    = Array.isArray(window.hits_last_US)    ? window.hits_last_US    : [];

  // Link-Mapping
  let k = 1;
  for (let f = 0; f < usFebList.length; f++)
  {
    const usFeb    = Number(usFebList[f]);
    const usFebPos = Number(usFebPosList[f] ?? 0);

    const feblink = (usFebPos * 9) + (usFeb * maxChips);

    const linkMap = isChip
        ? [0, 1, 2, 13]
        : Array.from({ length: 9 }, (_, x) => x + feblink);

    linkmapping = new Link_mapping(dut, usFeb, usFeb, usFebPos, usFebPos);

    let usAllGreen = true;
    let usHasOrange = false;
    let usNoHits     = true;

    //maxRows bestimmen
    let nChips;
    let maxRows;
    if (dut === "ladder_inner")
    {
        nChips = 6;
        maxRows = 9;
    }
    else if (dut === "module_inner")
    {
        nChips = 6;
        maxRows = 36;
    }
    else if (dut === "chip")
    {
        nChips = 2;
        maxRows = 1
    }
    else if (dut === "outer_module_L4")
    {
        nChips = 18;
        maxRows = 36;
    }
    else if (dut === "outer_ladder_L4")
    {
        nChips = 18;
        maxRows = 9;
    }
    else if (dut === "outer_module_L3")
    {
        nChips = 17;
        maxRows = 36;
    }
    else
    {
        nChips = 17;
        maxRows = 9;
    }

    for (let x = 0; x < maxRows; x++)
    {
        const uiRow = rowOffset + x;
        let a = x % nChips
        let b = Math.floor(x/nChips)

        const linkIdxRaw = linkmapping.getLinkMapping(a, b);
        const linkIndices = Array.isArray(linkIdxRaw)
        ? linkIdxRaw
        : [linkIdxRaw];

        for (const linkIdx of linkIndices)
        {
            const base = 2*(usFeb+1) + LINK_STRIDE * linkIdx;
            if ((base + 3) >= value.length) break; // out of bounds safeguard

            const w0      = Number(value[base]);
            const locked  = !!(w0 & (1 << 31));
            const ready   = !!(w0 & (1 << 30));
            const disperr = Number(value[base + 1]);
            const berr    = Number(value[base + 2]);
            const hits    = Number(value[base + 3]);

            const prevDisp = Number(window.disperr_last_US[uiRow] ?? disperr);
            const prevBerr = Number(window.berr_last_US[uiRow]    ?? berr);
            const prevHits = Number(window.hits_last_US[uiRow]    ?? hits);

            const dDisp = disperr - prevDisp;
            const dBerr = berr    - prevBerr;
            const dHits = hits    - prevHits;

            const lockedDiv = document.getElementById(`locked_${uiRow}`);
            const readyDiv  = document.getElementById(`ready_${uiRow}`);
            const errDiv    = document.getElementById(`err_${uiRow}`);
            const b10Div    = document.getElementById(`8b10berr_${uiRow}`);
            const hitsDiv   = document.getElementById(`hits_${uiRow}`);

            if (lockedDiv) lockedDiv.style.backgroundColor = locked ? "lightgreen" : "red";
            if (readyDiv)  readyDiv.style.backgroundColor  = ready  ? "lightgreen" : "red";

            if (!(locked && ready))
            {
                usAllGreen = false;
            }
            else if (dBerr > 0 || dDisp > 0) {
                usHasOrange = true;
            }
            else if (dHits == 0) {
                usNoHits = false;
            }

            if (errDiv) {
            errDiv.textContent = String(dDisp);
            errDiv.style.backgroundColor = (dDisp === 0) ? "rgba(0,255,0,0.2)" : "rgba(255,0,0,0.2)";
            }
            if (b10Div) {
            b10Div.textContent = String(dBerr);
            b10Div.style.backgroundColor = (dBerr === 0) ? "rgba(0,255,0,0.2)" : "rgba(255,0,0,0.2)";
            }
            if (hitsDiv) {
            hitsDiv.textContent = String(dHits);
            }

            window.disperr_last_US[uiRow] = disperr;
            window.berr_last_US[uiRow]    = berr;
            window.hits_last_US[uiRow]    = hits;
        }
    }
    const summaryDiv = document.getElementById(`lvdsSummaryUS_${k}`);
    if (summaryDiv)
    {
        if (!usAllGreen) {
            summaryDiv.style.backgroundColor = "#ff0000";      // Red
        }
        else if (usHasOrange) {
            summaryDiv.style.backgroundColor = "orange";       // Degraded
        }
        else if (usNoHits) {
            summaryDiv.style.backgroundColor = "#bfbfbf";      // Grey (no activity)
        }
        else {
            summaryDiv.style.backgroundColor = "lightgreen";   // Healthy
        }
    }
    rowOffset += linkMap.length;
    k += 1;
  }
}

async function update_pcls_DS(valuex)
{
  const value = (typeof valuex === "string") ? JSON.parse(valuex) : valuex;
  if (!Array.isArray(value)) return;

  // DUT und Setup lesen
  const rpc = await mjsonrpc_db_get_values([
    "/PixelQC/Dut/DUT",
    "/PixelQC/Setup"
  ]);

  const dut   = String(rpc?.result?.data?.[0] ?? "").toLowerCase();
  const setup = rpc?.result?.data?.[1] ?? {};

  const streams = Array.isArray(setup.streams) ? setup.streams : [];
  const feb     = Array.isArray(setup.feb)     ? setup.feb     : [];
  const feb_pos = Array.isArray(setup.feb_pos) ? setup.feb_pos : [];

  // feblink2 korrekt berechnen (Operator-Prioritäten klar halten)
  const dsFebPos = Number(feb_pos[DS] ?? 0);
  const dsFeb    = Number(feb[DS] ?? 0);
  const feblink2 = dsFebPos * 9 + (dsFeb *36);

  // Layout/Visibility anwenden (existierende Helper)
  if (typeof applyUSDSVisibility === "function") applyUSDSVisibility();
  if (typeof applyChipLayout === "function")     applyChipLayout("DS", feblink2, dut);

  const isChip = (dut === "chip");

  // Link-Mapping
  const linkMap = isChip
    ? [0, 1, 2, 13]
    : Array.from({ length: 36 }, (_, x) => x + feblink2);

  linkmapping = new Link_mapping(dut, dsFeb, dsFeb, dsFebPos, dsFebPos);

  // DS-Index finden
  const DS = streams.indexOf("DS");
  if (DS < 0) {
    console.warn('Stream "DS" not found in setup.streams:', streams);
    return;
  }
  //maxRows bestimmen
  let nChips;
  let k;
  let maxRows;
  if (dut === "ladder_inner")
    {
        nChips = 6;
        k = 9;
        maxRows = 2 * k;
    }
    else if (dut === "module_inner")
    {
        nChips = 6;
        k = 36;
        maxRows = 2 * k;
    }
    else if (dut === "chip")
    {
        nChips = 2;
        k = 0;
        maxRows = 1;
    }
    else if (dut === "outer_module_L4")
    {
        nChips = 18;
        k = 36;
        maxRows = 2 * k;
    }
    else if (dut === "outer_ladder_L4")
    {
        nChips = 18;
        k = 9;
        maxRows = 2 * k;
    }
    else if (dut === "outer_module_L3")
    {
        nChips = 17;
        k = 32;
        maxRows = 2 * k + 4;
    }
    else
    {
        nChips = 17;
        k = 8;
        maxRows = 2 * k + 1;
    }

  // Layout/Visibility anwenden (existierende Helper)
  if (typeof applyUSDSVisibility === "function") applyUSDSVisibility();
  if (typeof applyChipLayout === "function")     applyChipLayout("DS", feblink2, dut); //check what this does

  // Rolling-Diff Speicher vorbereiten (global erwartet)
  window.disperr_last_DS = Array.isArray(window.disperr_last_DS) ? window.disperr_last_DS : [];
  window.berr_last_DS    = Array.isArray(window.berr_last_DS)    ? window.berr_last_DS    : [];
  window.hits_last_DS    = Array.isArray(window.hits_last_DS)    ? window.hits_last_DS    : [];

  for (let x = k; x < maxRows; x++)
  {
    let a = x % nChips
        let b = Math.floor(x/nChips)
        const linkIdxRaw = linkmapping.getLinkMapping(a, b);

    const linkIndices = Array.isArray(linkIdxRaw)
    ? linkIdxRaw
    : [linkIdxRaw];

    for (const linkIdx of linkIndices)
    {
        const base = 2*(dsFeb+1) + LINK_STRIDE * linkIdx;
        if ((base + 3) >= value.length) break; // out of bounds

        const w0      = Number(value[base]);
        const locked  = !!(w0 & (1 << 31));
        const ready   = !!(w0 & (1 << 30));
        const disperr = Number(value[base + 1]);
        const berr    = Number(value[base + 2]);
        const hits    = Number(value[base + 3]);

        const prevDisp = Number(window.disperr_last_DS[x] ?? disperr);
        const prevBerr = Number(window.berr_last_DS[x]    ?? berr);
        const prevHits = Number(window.hits_last_DS[x]    ?? hits);

        const dDisp = disperr - prevDisp;
        const dBerr = berr    - prevBerr;
        const dHits = hits    - prevHits;

        const lockedDiv = document.getElementById(`locked_${x}_DS`);
        const readyDiv  = document.getElementById(`ready_${x}_DS`);
        const errDiv    = document.getElementById(`err_${x}_DS`);
        const b10Div    = document.getElementById(`8b10berr_${x}_DS`);
        const hitsDiv   = document.getElementById(`hits_${x}_DS`);

        if (lockedDiv) lockedDiv.style.backgroundColor = locked ? "lightgreen" : "red";
        if (readyDiv)  readyDiv.style.backgroundColor  = ready  ? "lightgreen" : "red";

        if (errDiv) {
        errDiv.textContent = String(dDisp);
        errDiv.style.backgroundColor = (dDisp === 0) ? "rgba(0,255,0,0.2)" : "rgba(255,0,0,0.2)";
        }
        if (b10Div) {
        b10Div.textContent = String(dBerr);
        b10Div.style.backgroundColor = (dBerr === 0) ? "rgba(0,255,0,0.2)" : "rgba(255,0,0,0.2)";
        }
        if (hitsDiv) {
        hitsDiv.textContent = String(dHits);
        }

        window.disperr_last_DS[x] = disperr;
        window.berr_last_DS[x]    = berr;
        window.hits_last_DS[x]    = hits;
    }
  }
}

async function update_pcms(valuex) {
    console.log("Updating PCMS")
  const value = (typeof valuex === "string") ? JSON.parse(valuex) : valuex;
  if (!Array.isArray(value)) return;

  const rpc = await mjsonrpc_db_get_values([
    "/PixelQC/Dut/DUT",
    "/PixelQC/Setup",
    "/Equipment/LinksCentral/Settings/LVDSLinkInvert"
  ]);

  const dutRaw = rpc?.result?.data?.[0];
  const dut = String(dutRaw ?? "").toLowerCase();

  const setup = rpc?.result?.data?.[1] ?? {};
  const streams = Array.isArray(setup.streams) ? setup.streams : [];
  const feb     = setup.feb     ?? [];
  const feb_pos = setup.feb_pos ?? [];

  // US-Index finden
  const US = streams.indexOf("US");
  if (US < 0) {
    console.warn('Stream "US" not found in setup.streams:', streams);
    return;
  }
  const DS = streams.indexOf("DS");
  if (DS < 0) {
    console.warn('Stream "DS" not found in setup.streams:', streams);
    return;
  }

  // Support both array and object shapes for feb/feb_pos
  const pickByIndex = (src, idx) => {
    if (Array.isArray(src)) return Number(src[idx] ?? 0);
    if (src && typeof src === "object") {
      const key = streams[idx];
      return Number(src[key] ?? 0);
    }
    return 0;
  };

  const isChipOrInner = ["chip", "ladder_inner"].includes(dut);
  const maxChips = isChipOrInner ? 12 : 36;

  const usFebPos = pickByIndex(feb_pos, US);
  const dsFebPos = pickByIndex(feb_pos, DS);
  const usFeb    = pickByIndex(feb, US);
  const dsFeb    = pickByIndex(feb, DS);

  // Operatoren klar setzen
  const feblinkUS = (usFebPos * 9);
  const feblinkDS = (dsFebPos * 9);

  const isChip = (dut === "chip");

  const lvdsInvert = rpc?.result?.data?.[2];

  // Link-Mapping
  const linkMapUS = isChip
    ? [0, 1, 2, 13]
    : Array.from({ length: 9 }, (_, x) => x);

  linkmapping = new Link_mapping(dut, usFeb, dsFeb, usFebPos, dsFebPos);

  let nChipsPerSide;
  let k;
  let maxRows;
  if (dut === "ladder_inner")
    {
        nChipsPerSide = 3;
        k = 3;
        maxRows = 2 * k;
    }
    else if (dut === "module_inner")
    {
        nChipsPerSide = 3;
        k = 9;
        maxRows = 2*k;
    }
    else if (dut === "chip")
    {
        nChipsPerSide = 1;
        k = 0;
        maxRows = 2 * k;
    }
    else if (dut === "outer_module_L4")
    {
        nChipsPerSide = 9;
        k = 36;
        maxRows = 2 * k;
    }
    else if (dut === "outer_ladder_L4")
    {
        nChipsPerSide = 9;
        k = 9;
        maxRows = 2 * k;
    }
    else if (dut === "outer_module_L3")
    {
        nChipsPerSide = 8;
        k = 32;
        maxRows = 2*k + 4;
    }
    else
    {
        nChipsPerSide = 8;
        k = 8;
        maxRows = 2 * k + 1;
    }

  for (let x = 0; x < maxRows; x++)
  {
    console.log("PCMS raw value:", value);
    console.log("PCMS length:", value.length);
    let a = x % nChipsPerSide
        let b = Math.floor(x/nChipsPerSide)
        const linkIdx = linkmapping.getLinkMapping(a, b);
    if (typeof linkIdx !== "number" || Number.isNaN(linkIdx)) continue;
    for (let start_index = 0; start_index + 7 < value.length; start_index += 8)
    {
        const febIndex = start_index / 8;
        const globalLink = febIndex * 9 + x;
        const this_feb = parseInt(value[start_index], 16);
        const matrixDiv = document.getElementById(`matrix_${globalLink}`);
        let pos_A = start_index + 2
        let pos_A2 = start_index + 3
        let pos_B = start_index + 4
        let pos_B2 = start_index + 5
        let pos_C = start_index + 6
        let pos_C2 = start_index + 7
        let is_A = false
        let is_B = false
        let is_C = false
        if (linkIdx < 32)
            is_A = Math.floor(value[pos_A]/(2**linkIdx))%2
        else
            is_A = Math.floor(value[pos_A2]/(2**(linkIdx-32)))%2
        if (linkIdx < 32)
            is_B = Math.floor(value[pos_B]/(2**linkIdx))%2
        else
            is_B = Math.floor(value[pos_B2]/(2**(linkIdx-32)))%2
        if (linkIdx < 32)
            is_C = Math.floor(value[pos_C]/(2**linkIdx))%2
        else
            is_C = Math.floor(value[pos_C2]/(2**(linkIdx-32)))%2

        if (is_A && is_B && is_C)
            matrixDiv.textContent =  "ND"
        else if (!is_A && !is_B && !is_C)
            matrixDiv.textContent =  "-"
        else if (is_A && !is_B && !is_C)
            matrixDiv.textContent =  "A"
        else if (!is_A && is_B && !is_C)
            matrixDiv.textContent =  "B"
        else if (!is_A && !is_B && is_C)
            matrixDiv.textContent =  "C"
        else
            matrixDiv.textContent =  "2?"

        const invertDiv = document.getElementById(`invert_${globalLink}`);
        if (get_LVDS_link_invert(lvdsInvert, this_feb, linkIdx))
            invertDiv.textContent = "y"
        else
            invertDiv.textContent = "n"

        let this_lvdsInvert = lvdsInvert
        let this_linkIdx = linkIdx
        invertDiv.onclick = function ()
        {
            toggle_LVDS_link_invert(this_lvdsInvert, this_feb, this_linkIdx)
        }
    }
  }

  const linkMapDS = isChip
    ? [0, 1, 2, 13]
    : Array.from({ length: 9 }, (_, x) => x + feblinkDS);
  const maxRowsDS = linkMapDS.length;

  for (let x = 0; x < maxRowsDS; x++) {
    const linkIdx = linkMapDS[x];
    if (typeof linkIdx !== "number" || Number.isNaN(linkIdx)) continue;
    const matrixDiv   = document.getElementById(`matrix_${x}_DS`);
    let start_index = 0
    let  pcms_idx = 1
    if (dsFeb > 0) {
        while (pcms_idx < value.length) {
            let n_feb = parseInt(value[pcms_idx-1], 16)
            if (n_feb == dsFeb) {
                start_index = pcms_idx -1
                break
            }
            pcms_idx = pcms_idx + 8 // + 8*n_active_links
        }
    }

    let pos_A = start_index + 2
    let pos_A2 = start_index + 3
    let pos_B = start_index + 4
    let pos_B2 = start_index + 5
    let pos_C = start_index + 6
    let pos_C2 = start_index + 7
    let is_A = false
    let is_B = false
    let is_C = false
    if (linkIdx < 32)
        is_A = Math.floor(value[pos_A]/(2**linkIdx))%2
    else
        is_A = Math.floor(value[pos_A2]/(2**(linkIdx-32)))%2
    if (linkIdx < 32)
        is_B = Math.floor(value[pos_B]/(2**linkIdx))%2
    else
        is_B = Math.floor(value[pos_B2]/(2**(linkIdx-32)))%2
    if (linkIdx < 32)
        is_C = Math.floor(value[pos_C]/(2**linkIdx))%2
    else
        is_C = Math.floor(value[pos_C2]/(2**(linkIdx-32)))%2

    if (is_A && is_B && is_C)
        matrixDiv.textContent =  "ND"
    else if (!is_A && !is_B && !is_C)
        matrixDiv.textContent =  "-"
    else if (is_A && !is_B && !is_C)
        matrixDiv.textContent =  "A"
    else if (!is_A && is_B && !is_C)
        matrixDiv.textContent =  "B"
    else if (!is_A && !is_B && is_C)
        matrixDiv.textContent =  "C"
    else
        matrixDiv.textContent =  "2?"

    const invertDiv   = document.getElementById(`invert_${x}_DS`);
    if (get_LVDS_link_invert(lvdsInvert, dsFeb, linkIdx))
        invertDiv.textContent = "y"
    else
        invertDiv.textContent = "n"
    let this_lvdsInvert = lvdsInvert
    let this_feb = dsFeb
    let this_linkIdx = linkIdx
    invertDiv.onclick = function () {
        toggle_LVDS_link_invert(this_lvdsInvert, this_feb, this_linkIdx)
    }

    }
}
update_pcms()

function toHexString(num) {
  return "0x" + Number(num).toString(16).toUpperCase();
}

function mirrorHex(rawEl, hexEl) {
  const render = () => {
    const txt = rawEl.textContent.trim();
    // Zahl robust parsen
    const num = Number(txt);
    if (Number.isFinite(num)) {
      hexEl.textContent = toHexString(num);
      return;
    }
    // Falls ODB bereits 0x... liefert, einfach übernehmen
    if (/^0x[0-9a-f]+$/i.test(txt)) {
      hexEl.textContent = txt.toUpperCase();
      return;
    }
    // Fallback: unverändert anzeigen
    hexEl.textContent = txt;
  };

  // Reagiert auf ODB-Updates ohne Polling, kein Flackern
  const obs = new MutationObserver(render);
  obs.observe(rawEl, { childList: true, characterData: true, subtree: true });
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  mirrorHex(
    document.getElementById("asicMaskRaw"),
    document.getElementById("asicMaskHex")
  );
  mirrorHex(
    document.getElementById("lvdsMaskRaw"),
    document.getElementById("lvdsMaskHex")
  );
});

// etwas warten, bis ODB die Werte eingetragen hat:
function startQCHisto () {
    mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/QCHistoStart"], [true]).then(function(rpc) {
        //ADD something to wait!
    })
}

function configQCHisto () {
    mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixConfig"], [true]).then(function(rpc) {
        //ADD something to wait!
    })
}

function TADCconfigQCHisto () {
    mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/MupixTDACConfig"], [true]).then(function(rpc) {
        //ADD something to wait!
    })
}

function resetMaskQCHisto () {
    mjsonrpc_db_paste(["/Equipment/PixelsCentral/Commands/QCHisto reset"], [true]).then(function(rpc) {
        //ADD something to wait!
    })
}

function appendSourceQCHisto () {
    var chip_number = document.getElementById("noise_scan_chip_number_config").textContent
    files = ["/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/TDACFILE", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/HITMAPFILE"]
    mjsonrpc_db_get_values(files).then(function(rpc) {
        tadcfile = rpc.result.data[0]
        hmapfile = rpc.result.data[1]
        let position1 = tadcfile.search(".bin")
        var tadcfile2 = tadcfile.substr(0,position1) + "_source.bin"
        let position2 = hmapfile.search(".bin")
        var hmapfile2 = hmapfile.substr(0,position2) + "_source.bin"
        new_names = [tadcfile2, hmapfile2]
        mjsonrpc_db_paste(files, new_names).then(function(rpc) {
            //Nothing to do?
        })
    }).catch(function (error) {
        alert(error)
    })
}

function prependSourceQCHisto () {
    var chip_number = document.getElementById("noise_scan_chip_number_config").textContent
    files = ["/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/TDACFILE", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/HITMAPFILE"]
    mjsonrpc_db_get_values(files).then(function(rpc) {
        tadcfile = rpc.result.data[0]
        hmapfile = rpc.result.data[1]
        let position_s = tadcfile.search("source")
        if (position_s != -1) {
            return;
        }
        let position1 = tadcfile.lastIndexOf("/")
        var tadcfile2 = tadcfile.substring(0, position1+1) + "source_scan_" + tadcfile.substring(position1+1)
        let position2 = hmapfile.lastIndexOf("/")
        let position3 = hmapfile.lastIndexOf("_")
        var hmapfile2 = hmapfile.substring(0, position2+1) + "source_scan_" + hmapfile.substring(position2+1, position3) + ".bin"
        new_names = [tadcfile2, hmapfile2]
        mjsonrpc_db_paste(files, new_names).then(function(rpc) {
            //Nothing to do?
        })
    }).catch(function (error) {
        alert(error)
    })
}

//HitMap related functions

function drawSquareHitMap(canvas, context, color, x, y){
    context.fillStyle = color;
    //context.fillRect(x*(canvas.width/256)*0.99, y*((canvas.height/250)*0.9)*0.99, (canvas.width/256), ((canvas.height/250)*0.9))
    context.fillRect(x, y, (canvas.width/256), ((canvas.height/250)*0.9))
}


function getFileName(rpc) {
    return function(resolve) {
        filename = rpc.result.data[0]
        let position = filename.search("sequencer")
        filename2 = filename.substr(position)
        resolve(filename2)
    }
}

function getFileName2(rpc) {
    return function(resolve) {
        filename = rpc
        let position = filename.search("sequencer")
        filename2 = filename.substr(position)
        resolve(filename2)
    }
}

function plot_hitmap(buf, canvas) {
    var context = canvas.getContext("2d");
    context.save()
    noise_scan_info = ""
    tot_noisy_hits = 0
    tot_noisy_pixels = 0
    val_max = -1
    for (var iu = 0; iu < 64000; ++iu) {
        if (buf[iu] > val_max)
            val_max = buf[iu]
    }
    val_max += 1
    for (var c = 0; c < 256; ++c) {
        for (var r = 249; r >= 0; --r) {
            if (buf[c*250+r] > 0) {
                tot_noisy_pixels += 1
                tot_noisy_hits += buf[c*250+r]
            }
            val = buf[c*250+r]
            val += 1
            if (val_max > 1) {
                val = Math.log(val)/Math.log(val_max)
            }
            else {
                val = val/val_max
            }
            color_rgb = evaluate_cmap(val, "viridis", false)
            color = "rgb(" + color_rgb.toString() + ")"
            drawSquareHitMap(canvas, canvas.getContext('2d'), color, c, 249 - r);
        }
    }
    noise_scan_info = "Tot Hits = " + tot_noisy_hits.toString() + " from " + tot_noisy_pixels.toString() + " pixels (" + (tot_noisy_pixels*100./64000).toFixed(2) + "% Pixels)"
    // document.getElementById("noise_scan_info").textContent = noise_scan_info
    context.restore()
    context.fillStyle = "rgb(255,255,255)"
    context.fillRect(0, canvas.height*0.95, canvas.width, canvas.height*0.05)
    context.save()
    context.font = "10px Arial";
    context.fillStyle = "rgb(0,0,0)"
    context.fillText(noise_scan_info, 0, canvas.height -5);
    context.restore()

}


function plot_mask(buf, canvas) {
    var context = canvas.getContext("2d");
    context.save()
    noise_scan_info = ""
    tot_noisy_pixels = 0
    val_max = -1
    for (var c = 0; c < 256; ++c) {
        for (var r = 0; r < 256; ++r) {
            if (r > 249)
                continue
            if (buf[c*256+r] > val_max)
                val_max = buf[c*256+r]
        }
    }
    if (val_max <= 0)
        val_max = 1
    val_max = 0x47
    for (var c = 0; c < 256; ++c) {
        for (var r = 249; r >= 0; --r) {
            if (buf[c*256+r] === 0) {
                tot_noisy_pixels += 1
            }
            color_rgb = evaluate_cmap((buf[c*256+r]&0x47)/val_max, "plasma", false)
            //color_rgb = evaluate_cmap(buf[r*256+c]/val_max, "PuBu", true)
            color = "rgb(" + color_rgb.toString() + ")"
            drawSquareHitMap(canvas,canvas.getContext('2d'), color, c, 249-r);
        }
    }
    noise_scan_info = "Tot masked pixels = " + tot_noisy_pixels.toString() + " (" + tot_noisy_pixels*100./64000. + "%)"
    document.getElementById("noise_scan_info").textContent = noise_scan_info
    context.restore()
    context.fillStyle = "rgb(255,255,255)"
    context.fillRect(0, canvas.height*0.95, canvas.width, canvas.height*0.05)
    context.save()
    context.font = "10px Arial";
    context.fillStyle = "rgb(0,0,0)"
    context.fillText(noise_scan_info, 0, canvas.height -5);
    context.restore()
}

function draw_hitmap() {
    folder = document.getElementById("noise_scan_hitmap_folder").textContent
    let position = folder.search("sequencer")
    foldername = folder.substr(position)
    let canvas=document.getElementById('hitmap_canvas');
    canvas.getContext("2d").reset()
    document.getElementById("noise_scan_info").textContent = "Select hitmap"
    file_picker(foldername, "*.bin", load_bin_and_display);
    function load_bin_and_display (filename) {
        file_load_bin(filename, buf => {
            plot_hitmap(buf, canvas)
        });
    }
 }

function draw_hitmap_current() {
    let canvas=document.getElementById('hitmap_canvas');
    canvas.getContext("2d").reset()
    var chip_number = document.getElementById("noise_scan_chip_number_config").textContent
    document.getElementById("noise_scan_info").textContent = "Loading current hitmap"
    mjsonrpc_db_get_values(["/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/HITMAPFILE"]).then(function(rpc) {
        var promise_hitmap = new Promise(getFileName(rpc))
        promise_hitmap.then( function(filename) {
            file_load_bin(filename, buf => {
                plot_hitmap(buf, canvas)
            });
        }).catch(function(error) {
            alert(error);
        });
    })
 }

 function draw_mask() {
    folder = document.getElementById("noise_scan_mask_folder").textContent
    let position = folder.search("sequencer")
    foldername = folder.substr(position)
    let canvas=document.getElementById('hitmap_canvas');
    canvas.getContext("2d").reset()
    document.getElementById("noise_scan_info").textContent = "Select mask"
    file_picker(foldername, "*.bin", load_bin_and_display);
    function load_bin_and_display (filename) {
        file_load_bin(filename, buf => {
            plot_mask(buf, canvas)
        });
    }
 }

 function draw_mask_current() {
    let canvas=document.getElementById('hitmap_canvas');
    canvas.getContext("2d").reset()
    var chip_number = document.getElementById("noise_scan_chip_number_config").textContent
    document.getElementById("noise_scan_info").textContent = "Loading current mask"
    mjsonrpc_db_get_values(["/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/TDACFILE"]).then(function(rpc) {
        var promise_hitmap = new Promise(getFileName(rpc))
        promise_hitmap.then( function(filename) {
            file_load_bin(filename, buf => {
                plot_mask(buf, canvas)
            })
        })
    })
 }

 function noise_scan_update_chip_number (chip_number) {
    mjsonrpc_db_get_values(["/Equipment/PixelsCentral/Commands/MupixChipToConfigure"]).then(rpc => {
        let chip_number = rpc.result.data[0];
        if (chip_number == 999){
            chip_number = 0
        }
    let mask_file = document.getElementById("noise_scan_mask_file")
    mask_file.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/TDACFILE" )
    let hitmap_file = document.getElementById("noise_scan_hitmap_file")
    hitmap_file.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/TDACS/" + chip_number.toString() + "/HITMAPFILE" )
    let threshold = document.getElementById("noise_scan_threshold")
    threshold.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/VDACS/" + chip_number.toString() + "/ThHigh" )
    let threshold_low = document.getElementById("noise_scan_threshold_low")
    threshold_low.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/VDACS/" + chip_number.toString() + "/ThLow" )
    let threshold_vpdac = document.getElementById("noise_scan_vpdac")
    threshold_vpdac.setAttribute("data-odb-path", "/Equipment/PixelsCentral/Settings/BIASDACS/" + chip_number.toString() + "/VPDAC" )
 })
}






//  noise_scan_update_chip_number()

 function slow_control_update_chip_number (chip_number) {
    // TODO: MK add this like in VTX
    // for (sc in sc_adc_name_list) {
    //     let path = configManager.get_sc_variable_path(chip_number, sc)
    //     let plh = document.getElementById("slow_control_" + sc)
    //     plh.setAttribute("data-odb-path", path)
    //     let plhc = document.getElementById("slow_control_" + sc + "_converted")
    //     plhc.setAttribute("data-odb-path", path)
    //     plhc.setAttribute("data-format", "%f3")
    //     plhc.setAttribute("data-formula", sc_adc_name_list[sc]["convert_function"])
    // }
 }


//QC Monitoring stuff

function reset_monitor_plot_visibility() {
    document.getElementById("monitoring_plot_iv").style["display"] = "none"
    document.getElementById("monitoring_plot_vdac_scans").style["display"] = "none"
    document.getElementById("monitoring_plot_vdac_power").style["display"] = "none"
}

function show_monitoring_histo(test_name) {
    reset_monitor_plot_visibility()
    if (test_name === "iv_scan") {
        document.getElementById("monitoring_plot_iv").style["visibility"] = "visible"
        document.getElementById("monitoring_plot_iv").style["display"] = "inline-block"
        let p = document.getElementById("monitoring_plot_iv").mpg;
        p.param.xAxis.min = -0.5
        p.param.yAxis.max = 10
        p.param.yAxis.min = -60
        let pnn = parseInt(document.getElementById("partNumber").innerText)
        if (pnn == 382) {
            p.param.xAxis.max = 25
        }
        else if (pnn == 408) {
            p.param.xAxis.max = 25
            p.param.yAxis.min = -180
        }
        else if (pnn == 385) {
            p.param.xAxis.max = 95
        }
        else if (pnn == 420) {
            p.param.xAxis.max = 95
        }
        else {
            p.param.xAxis.max = 125
        }
        p.error = null
    }
    else if (test_name == "vdac_scans") {
        document.getElementById("monitoring_plot_vdac_scans").style["visibility"] = "visible"
        document.getElementById("monitoring_plot_vdac_scans").style["display"] = "inline-block"
        let pv = document.getElementById("monitoring_plot_vdac_scans").mpg;
        pv.error = null
    }
    else if (test_name == "vdac_power_consumption") {
        mjsonrpc_db_get_values(["/PixelQC/Dut/DUT"]).then(rpc => {
            const dut = rpc.result.data[0];
        if (dut == "chip")
            {
            document.getElementById("monitoring_plot_vdac_power").style["visibility"] = "visible"
            document.getElementById("monitoring_plot_vdac_power").style["display"] = "inline-block"
            document.getElementById("monitoring_plot_VPDAC").mpg.error = null;
            document.getElementById("monitoring_plot_BLPix").mpg.error = null;
            document.getElementById("monitoring_plot_ref_Vss").mpg.error = null;
            }
        if (dut =="ladder_inner")
                {
                mjsonrpc_db_get_values(["/PixelQC/Flags/stream"]).then(rpc => {
                        const stream = rpc.result.data[0];
                if (stream == "DS"){
                    document.getElementById("monitoring_plot_vdac_power_DS").style["visibility"] = "visible"
                    document.getElementById("monitoring_plot_vdac_power_DS").style["display"] = "inline-block"
                    document.getElementById("monitoring_plot_VPDAC_DS").mpg.error = null;
                    document.getElementById("monitoring_plot_BLPix_DS").mpg.error = null;
                    document.getElementById("monitoring_plot_ref_Vss_DS").mpg.error = null;
                }
                else if (stream=="US")
                {
                    document.getElementById("monitoring_plot_vdac_power_US").style["visibility"] = "visible"
                    document.getElementById("monitoring_plot_vdac_power_US").style["display"] = "inline-block"
                    document.getElementById("monitoring_plot_VPDAC_US").mpg.error = null;
                    document.getElementById("monitoring_plot_BLPix_US").mpg.error = null;
                    document.getElementById("monitoring_plot_ref_Vss_US").mpg.error = null;
                }
                })
                }
        }
    )
    }
}

// SLOW CONTROL STUFF

adc_name_list = [
    "ref_vssa",
    "Baseline",
    "blpix",
    "thpix",
    "blpix_2",
    "ThLow",
    "ThHigh",
    "TEST_OUT",
    "vssa",
    "thpix_2",
    "VCAL",
    "VTemp1",
    "VTemp2"
]

function SCSelectADC (adc_name) {
    odb_keys = []
    odb_vals = []
    for (adcn of adc_name_list) {
        odb_keys.push("Equipment/PixelsCentral/Commands/MupixSlowControl/Mux_Address-" + adcn)
        if (adcn === adc_name)
            odb_vals.push(true)
        else
            odb_vals.push(false)
    }
    mjsonrpc_db_paste(odb_keys, odb_vals).then(function (rpc){
        //Nothing to do?
    }).catch(function (error){
        mjsonrpc_error_alert(error);
    })
}

function resetSC() {
    mjsonrpc_db_paste(["Equipment/PixelsCentral/Commands/MupixSlowControl/ADC reset"], [true]).then(function (rpc){
        //Nothing to do?
    }).catch(function (error){
        mjsonrpc_error_alert(error);
    })
}

function configureSC() {
    mjsonrpc_db_paste(["Equipment/PixelsCentral/Commands/MupixSlowControl/Configure read"], [true]).then(function (rpc){
        //Nothing to do?
    }).catch(function (error){
        mjsonrpc_error_alert(error);
    })
}

function readSC() {
    mjsonrpc_db_paste(["Equipment/PixelsCentral/Commands/MupixSlowControl/Perform read"], [true]).then(function (rpc){
        setTimeout(function(){
            mjsonrpc_db_paste(["Equipment/PixelsCentral/Commands/MupixSlowControl/Perform read"], [true]).then(function (rpc2){
                //nothing to do
            }).catch(function (error){
                mjsonrpc_error_alert(error);
            })
        }, 2000);
    }).catch(function (error){
        mjsonrpc_error_alert(error);
    })
}

//QC display stuff

function loadQCJSON() {
    folder = document.getElementById("noise_scan_hitmap_folder").textContent
    let position = folder.search("sequencer")
    foldername = "sequencer/pixels/python_qc/output"
    //let canvas=document.getElementById('hitmap_canvas');
    //canvas.getContext("2d").reset()
    //document.getElementById("noise_scan_info").textContent = "Select hitmap"
    file_picker(foldername, "*.json", load_json_and_display);
    function load_json_and_display (filename) {
        file_load_ascii(filename, buf => {
            jsondata = JSON.parse(buf)
            if (filename.includes("iv_scan")) {
                var hvVoltage = jsondata["HV voltage"];
                var hvCurrent = jsondata["HV current (µA)"];
                // console.log(hvVoltage)
            }

            // console.log(jsondata)
        });
    };
}


// Build a reverse index: DAC name -> group ("BIASDACS" | "CONFDACS" | "VDACS")
function buildDacGroupIndex() {
  const idx = {};
  if (typeof Mupix_DACs === "object" && Mupix_DACs) {
    Object.keys(Mupix_DACs).forEach(group => {
      (Mupix_DACs[group] || []).forEach(name => { idx[name] = group; });
    });
  }
  return idx;
}
const DAC_GROUP_INDEX = buildDacGroupIndex();

// Path: /Equipment/PixelsCentral/Settings/<GROUP>/<CHIP_ID>/<DAC_NAME>
function pathForDAC(chipId, dacName) {
  const group = DAC_GROUP_INDEX[dacName];
  if (!group) throw new Error(`Unknown DAC '${dacName}' (no group in Mupix_DACs)`);
  return `/Equipment/PixelsCentral/Settings/${group}/${chipId}/${dacName}`;
}

// Batch write ALL updates via db_paste (no slowcontrol trigger here)
async function dbSetMany(updates /* [{path,data}, ...] */) {
  // If your ODB expects numbers, switch to: const toWire = (v) => v;
  const toWire = (v) => String(v);
  const paths = updates.map(u => u.path);
  const data  = updates.map(u => toWire(u.data));
  await mjsonrpc_db_paste(paths, data);
}

// Populate the <select> from GlobalConfig.js (Mupix_DACs) with <optgroup>
function populateDACSelectFromConfig($sel) {
  const cfg = (typeof Mupix_DACs !== "undefined") ? Mupix_DACs : null;
  if (!cfg) return false;

  const frag = document.createDocumentFragment();
  Object.keys(cfg).forEach(group => {
    const og = document.createElement("optgroup");
    og.label = group; // e.g., BIASDACS, CONFDACS, VDACS
    (cfg[group] || []).forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      og.appendChild(opt);
    });
    frag.appendChild(og);
  });

  $sel.innerHTML = "";
  $sel.appendChild(frag);
  return true;
}

// UI init / event wiring
function initGlobalDACBox() {
  const $sel  = document.getElementById("dac-global-select");
  const $val  = document.getElementById("dac-global-value");
  const $from = document.getElementById("dac-global-chipstart");
  const $to   = document.getElementById("dac-global-chipend");
  const $btn  = document.getElementById("dac-global-apply");
  const $stat = document.getElementById("dac-global-status");
  if (!$sel || !$val || !$from || !$to || !$btn || !$stat) return;

  // Fill dropdown
  const ok = populateDACSelectFromConfig($sel);
  if (!ok) {
    $sel.innerHTML = `<option value="ThHigh">ThHigh</option>`;
  }

  // Defaults
  DEFAULT_CHIP_COUNT = 35; // adjust as needed
  if (!$from.value) $from.value = 0;
  if (!$to.value)   $to.value   = Math.max(0, DEFAULT_CHIP_COUNT);

  // Apply handler
  $btn.onclick = async () => {
    const dacName  = $sel.value;
    const group    = DAC_GROUP_INDEX[dacName]; // if you’re using the grouped version
    const rawVal   = $val.value;
    const dacValue = Number(rawVal); // change to String(rawVal) if ODB expects strings

    const start = Math.max(0, Number($from.value));
    const end   = Number($to.value);

    // Validation
    if (!dacName || (DAC_GROUP_INDEX && !group)) {
      $stat.textContent = "Unknown DAC. Check GlobalConfig.js (Mupix_DACs).";
      $stat.style.color = "red";
      return;
    }
    if (!Number.isFinite(dacValue)) {
      $stat.textContent = "Enter a numeric DAC value.";
      $stat.style.color = "red";
      return;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      $stat.textContent = "Invalid chip range. Ensure start ≤ end and both are numbers.";
      $stat.style.color = "red";
      return;
    }

    // Build updates for the inclusive range
    const updates = [];
    for (let chip = start; chip <= end; chip++) {
      updates.push({ path: pathForDAC(chip, dacName), data: dacValue });
    }

    // Debug preview
    console.debug("[DAC global] range:", start, "…", end,
                  "sample paths:", updates.slice(0,3).map(u => u.path));

    // Write
    $btn.disabled = true;
    $stat.textContent = `Writing ${dacName} = ${dacValue} to chips ${start}…${end}…`;
    $stat.style.color = "";

    try {
      await dbSetMany(updates);
      $stat.textContent = `Done: set ${dacName} = ${dacValue} on chips ${start}…${end}.`;
      $stat.style.color = "green";
    } catch (e) {
      const msg = e?.error?.message || e?.message || JSON.stringify(e);
      console.error("[DAC global] failed:", e);
      $stat.textContent = `Failed to write ${dacName}: ${msg}`;
      $stat.style.color = "red";
    } finally {
      $btn.disabled = false;
    }
  };
}


// Call once after the page is ready
initGlobalDACBox();



function monitoring_message_change(new_msg) {
    let textarea = document.getElementById("monitoring_messages_area")
    textarea.value += new_msg + '\r\n';
    textarea.scrollTop = textarea.scrollHeight;
}

function viewQC() {
    var v_pn = document.getElementById('view_pn').value
    var v_lot = document.getElementById('view_lot').value
    var v_item = document.getElementById('view_item').value
    var home_folder = document.getElementById('view_home_folder').textContent

    var json_folder = home_folder + "/online/userfiles/sequencer/pixels/python_qc/output/"
    var full_qc_file_name = json_folder + "full_qc_" + v_pn.toString() + "_" + v_lot.toString() + "_" + v_item.toString() + "_fastQC.json"
    //var full_qc_file_name = "sequencer/pixels/qctest/generic_qc_files/output/full_qc_" + v_pn.toString() + "_" + v_lot.toString() + "_" + v_item.toString() + "_fastQC.json"
    var promise_full_qc = new Promise(getFileName2(full_qc_file_name))
    promise_full_qc.then( function(filename) {
        file_load_ascii(filename, buf => {
            try {
                jsondata = JSON.parse(buf)
                document.getElementById("view_plots").style["visibility"] = "visible"
                document.getElementById("view_plots").style["display"] = "inline-block"
                document.getElementById("view_qc_score").textContent = jsondata["C1"]["QC_score"]
                if (jsondata["C1"]["Limitations"] === "") {
                    document.getElementById("view_qc_limitations").textContent = "None"
                }
                else {
                    document.getElementById("view_qc_limitations").textContent = jsondata["C1"]["Limitations"]
                }
                if (jsondata["C1"]["Failure"] === "") {
                    document.getElementById("view_qc_failure").textContent = "None"
                }
                else {
                    document.getElementById("view_qc_failure").textContent = jsondata["C1"]["Failure"]
                }
            }
            catch (error) {
                alert("Cannot read file " + full_qc_file_name)
            }
            document.getElementById("view_not_found").style["display"] = "none"
        }).catch(function(error) {
            alert("Cannot open file " + full_qc_file_name + " with the error " + error);
            document.getElementById("view_not_found").style["visibility"] = "visible"
            document.getElementById("view_plots").style["display"] = "none"
            document.getElementById("view_plots").style["visibility"] = "hidden"
        });
    }).catch(function(error) {
        //alert("Cannot open file " + full_qc_file_name + " witha error " + error);
        document.getElementById("view_plots").style["display"] = "none"
        document.getElementById("view_not_found").style["visibility"] = "visible"
        document.getElementById("view_not_found").style["display"] = "block"
    });

    //Check contact
    var cc_file_name = json_folder + "check_contact_" + v_pn.toString() + "_" + v_lot.toString() + "_" + v_item.toString() + ".json"
    var promise_cc = new Promise(getFileName2(cc_file_name))
    promise_cc.then( function(filename) {
        file_load_ascii(filename, buf => {
            document.getElementById("view_check_contact").style["visibility"] = "visible"
            document.getElementById("view_check_contact").style["display"] = "block"
            jsondata = JSON.parse(buf)
            text = ""
            for (var i = 0; i < jsondata["C1"]["Chip state"].length; ++i) {
                text += jsondata["C1"]["Chip state"][i] + " : " + jsondata["C1"]["LV current (mA)"][i].toString() + " (mA)<br>"
            }
            document.getElementById("view_check_contact_details").innerHTML = text
        })
    }).catch(function(error) {
        document.getElementById("view_check_contact").style["display"] = "none"
        alert("Cannot open file " + promise_cc);
    });

    //IV plot
    var iv_file_name = json_folder + "iv_scan_" + v_pn.toString() + "_" + v_lot.toString() + "_" + v_item.toString() + "_lv_1_conf_biasBlock_1.json"
    var promise_iv = new Promise(getFileName2(iv_file_name))
    promise_iv.then( function(filename) {
        file_load_ascii(filename, buf => {
            document.getElementById("view_plot_iv").style["visibility"] = "visible"
            document.getElementById("view_plot_iv").style["display"] = "block"
            jsondata = JSON.parse(buf)
            let p = document.getElementById("view_plot_iv").mpg;
            p.param.xAxis.min = -0.5
            p.param.yAxis.max = 10
            p.param.yAxis.min = -60
            let pnn = parseInt(v_pn)
            if (pnn == 382) {
                p.param.xAxis.max = 25
            }
            else if (pnn == 385) {
                p.param.xAxis.max = 95
            }
            else if (pnn == 420) {
                p.param.xAxis.max = 95
            }
            else {
                p.param.xAxis.max = 125
            }
            p.setData(0, jsondata["HV voltage"], jsondata["HV current (µA)"])
            p.error = null
        });
    }).catch(function(error) {
        document.getElementById("view_plot_iv").style["display"] = "none"
        alert("Cannot open file " + full_qc_file_name);
    });
}
window.update_pcls_US = update_pcls_US;
window.update_pcls_DS = update_pcls_DS;


// === 1) Einzelmaske auf Canvas rendern (nutzt evaluate_cmap + drawSquareHitMap) ===
function renderMaskToCanvas(buf, canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // max-Wert bestimmen (wie gehabt auf 0x47 geklemmt)
  let val_max = -1;
  for (let c = 0; c < 256; ++c) {
    for (let r = 0; r < 250; ++r) {
      const v = buf[c*256 + r];
      if (v > val_max) val_max = v;
    }
  }
  if (val_max <= 0) val_max = 1;
  val_max = 0x47;

  let masked = 0;
  for (let c = 0; c < 256; ++c) {
    for (let r = 249; r >= 0; --r) {
      const v = buf[c*256 + r];

      // <<< NEU: Masked zählen, wenn v < 0x40
      if (v < 0x40) masked++;

      const color_rgb = evaluate_cmap((v & 0x47) / val_max, "plasma", false);
      const color = "rgb(" + color_rgb.toString() + ")";
      drawSquareHitMap(canvas, ctx, color, c, 249 - r);
    }
  }
  return masked; // Anzahl maskierter Pixel für diesen Chip
}

// Kleine Helper-Funktion: Badge oben links in der Kachel
function drawBadge(ctx, x, y, text) {
  ctx.save();
  ctx.font = "14px Arial";
  const padX = 6, padY = 4;
  const metrics = ctx.measureText(text);
  const w = Math.ceil(metrics.width) + 2 * padX;
  const h = 18 + 2 * padY;

  // Hintergrund halbtransparent
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.strokeRect(x, y, w, h);

  // Text
  ctx.fillStyle = "black";
  ctx.fillText(text, x + padX, y + padY + 14);
  ctx.restore();
}

// Auto-Grid Plotter: bis zu 18 Masken, 1 = fullscreen, sonst grid
async function plot_masks_grid_auto(buffers, mainCanvas, labels = []) {
  const ctx = mainCanvas.getContext("2d");
  ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

  const n = Math.min(buffers.length, 18);
  if (n === 0) {
    const info = document.getElementById("noise_scan_info");
    if (info) info.textContent = "No files.";
    return;
  }

  // Einzige Maske → fullscreen
  if (n === 1) {
    const m = renderMaskToCanvas(buffers[0], mainCanvas);
    const chipLabel = labels[0] ? labels[0] : "#1";
    drawBadge(ctx, 10, 10, `${chipLabel} Masked = ${m}`);

    const info = document.getElementById("noise_scan_info");
    if (info) info.textContent = `1 mask shown.`;
    return;
  }

  // Multi → Grid
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = mainCanvas.width / cols;
  const cellH = mainCanvas.height / rows;

  let total_masked = 0;

  for (let i = 0; i < n; i++) {
    // Offscreen rendern
    const off = document.createElement("canvas");
    off.width = 256;
    off.height = 256;
    const m = renderMaskToCanvas(buffers[i], off);
    total_masked += m;

    const gx = i % cols;
    const gy = Math.floor(i / cols);

    const margin = 0.9;
    const scale = Math.min(cellW / 256, cellH / 256) * margin;
    const drawW = Math.floor(256 * scale);
    const drawH = Math.floor(256 * scale);
    const dx = gx * cellW + (cellW - drawW) / 2;
    const dy = gy * cellH + (cellH - drawH) / 2;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, dx, dy, drawW, drawH);

    // Beschriftung: US0 Masked = 250
    const chipLabel = labels[i] ? labels[i] : `#${i+1}`;
    drawBadge(ctx, dx + 6, dy + 6, `${chipLabel} Masked = ${m}`);
  }

  const info = document.getElementById("noise_scan_info");
  if (info) info.textContent = `${n} masks shown, total masked = ${total_masked}`;
}




// --- Hilfsfunktion: Pfade aus ODB ins richtige Format für file_load_bin bringen ---
function normalizeForMhttpd(path) {
  if (!path) return "";
  const p = String(path).trim();

  // Fall: absoluter Pfad -> ab "sequencer/" abschneiden
  const idx = p.indexOf("sequencer/");
  if (idx >= 0) {
    return p.substring(idx);
  }

  // Fall: schon relativ
  return p;
}

// --- Robustes Laden einer Binärmaske mit Timeout ---
function loadBinSafe(filename, timeoutMs = 7000) {
  return new Promise(resolve => {
    let done = false;
    const clean = (filename || "").trim();
    if (!clean) return resolve(null);

    const t = setTimeout(() => {
      if (!done) {
        console.warn("TDACFILE timeout:", clean);
        done = true;
        resolve(null);
      }
    }, timeoutMs);

    try {
      file_load_bin(clean, buf => {
        if (done) return;
        clearTimeout(t);
        done = true;
        if (!buf || buf.length === 0) {
          console.warn("TDACFILE leer/ungültig:", clean);
          resolve(null);
        } else {
          resolve(buf);
        }
      });
    } catch (e) {
      if (!done) {
        clearTimeout(t);
        console.error("TDACFILE exception:", clean, e);
        resolve(null);
      }
    }
  });
}

// --- Hauptfunktion: Masken aus ODB ableiten, robust laden und zeichnen ---
async function draw_masks_from_odb() {
  const info = document.getElementById("noise_scan_info");
  const canvas = document.getElementById("hitmap_canvas");

  try {
    // 1) Basiswerte aus ODB
    const keys = [
      "/PixelQC/Dut/DUT",
      "/PixelQC/Setup/feb_pos[0]",
      "/PixelQC/Setup/feb_pos[1]",
      "/PixelQC/Flags/stream"
    ];
    const rpc = await mjsonrpc_db_get_values(keys);
    const [dut, febUS, febDS, stream] = rpc.result.data;

    // 2) Chips pro Seite bestimmen
    let perSide;
    if (dut === "outer_ladder_L4") {
      perSide = 9;
    } else if (dut === "ladder_inner") {
      perSide = 3;
    } else {
      info.textContent = `DUT='${dut}' wird nicht unterstützt.`;
      return;
    }

    const startUS = Number(febUS)*9;
    const startDS = Number(febDS)*9;
    if (!Number.isFinite(startUS) || !Number.isFinite(startDS)) {
      info.textContent = "Ungültige FEBlink-Werte (US/DS).";
      return;
    }

    // 3) Stream mode interpretieren
    const bothSided = (stream === "both_sided");

    // 4) Chipnummern & Labels
    let chipNums = [];
    let chipLabels = [];
    if (bothSided) {
      const us = Array.from({ length: perSide }, (_, i) => startUS + i);
      const ds = Array.from({ length: perSide }, (_, i) => startDS + i);
      chipNums = us.concat(ds);
      chipLabels = [
        ...us.map((_, i) => `US${i}`),
        ...ds.map((_, i) => `DS${i}`)
      ];
    } else {
      const start = (stream === "US") ? startUS : startDS;
      chipNums = Array.from({ length: perSide }, (_, i) => start + i);
      chipLabels = chipNums.map((_, i) => `${stream || "US"}${i}`);
    }

    // 5) TDACFILE-Keys aus ODB
    const tdacKeys = chipNums.map(n => `/Equipment/PixelsCentral/Settings/TDACS/${n}/TDACFILE`);
    const rpc2 = await mjsonrpc_db_get_values(tdacKeys);
    const files = (rpc2.result.data || []).map(x => (typeof x === "string" ? x.trim() : ""));

    const entries = chipNums
      .map((chip, i) => ({ chip, label: chipLabels[i], file: files[i] }))
      .filter(e => e.file && e.file !== "-" && e.file.toLowerCase() !== "none");

    if (entries.length === 0) {
      info.textContent = "Keine TDACFILE-Pfade in der ODB gefunden.";
      return;
    }

    // 6) Masken sequenziell laden
    info.textContent = `Lade ${entries.length} Masken …`;
    const buffers = [];
    const labels = [];

    for (let i = 0; i < entries.length; i++) {
      const { file, label } = entries[i];
      const norm = normalizeForMhttpd(file);
      const shortName = norm.split("/").pop();

      info.textContent = `Lade Maske ${i + 1}/${entries.length}: ${shortName}`;
      console.debug("TDACFILE raw:", file, "→ normalized:", norm);

      const buf = await loadBinSafe(norm, 7000);
      if (buf) {
        buffers.push(buf);
        labels.push(label);
      } else {
        console.warn("Übersprungen (kein Buffer):", file, "→", norm);
      }
    }

    if (buffers.length === 0) {
      info.textContent = "Keine der TDACFILE-Dateien konnte geladen werden.";
      return;
    }

    // 7) Zeichnen
    await plot_masks_grid_auto(buffers, canvas, labels);

  } catch (e) {
    console.error(e);
    info.textContent = "Fehler beim ODB-Lesen/Maskenladen (Konsole prüfen).";
  }
}

// --- Source Scan Manual Intervention ---
function handleSourceScanIntervention(value) {
    console.log("handleSourceScanIntervention called with value:", value, "type:", typeof value);

    const popup = document.getElementById('sourceScanPopup');
    const nextSensorElem = document.getElementById('sourceNextSensor');

    console.log("Popup element:", popup);

    // Convert value to boolean if it's a string
    const isAdjusted = (value === true || value === 'true' || value === 1 || value === '1');
    console.log("isAdjusted:", isAdjusted);

    if (!isAdjusted) {
        // Show popup when position_adjusted is false
        console.log("Showing popup - position not adjusted");

        // Read the current sensor position from ODB
        mjsonrpc_db_get_values(["/PixelQC/Flags/source_sensor_position"]).then(rpc => {
            const sensorPosition = rpc.result.data[0];
            console.log("Current sensor position from ODB:", sensorPosition);
            nextSensorElem.textContent = sensorPosition !== null ? sensorPosition : 'N/A';
            console.log("Setting next sensor to:", nextSensorElem.textContent);
        }).catch(err => {
            console.error("Error reading sensor position:", err);
            nextSensorElem.textContent = 'N/A';
        });

        popup.style.display = 'block';
        console.log("Popup display set to block");
    } else {
        // Hide popup when position_adjusted is true
        console.log("Hiding popup - position adjusted");
        popup.style.display = 'none';
    }
}

// --- Button verbinden ---
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnShowMasksServer");
  if (btn) btn.addEventListener("click", draw_masks_from_odb);

  // Set up source scan OK button
  const sourceScanOkButton = document.getElementById('sourceScanOkButton');
  if (sourceScanOkButton) {
      sourceScanOkButton.addEventListener('click', () => {
          console.log("OK button clicked, setting source_sensor_position_adjusted to true");
          modbset('/PixelQC/Flags/source_sensor_position_adjusted', true);
      });
  }

  // Initialize source scan popup check after a short delay to ensure ODB is loaded
  setTimeout(() => {
      console.log("Checking initial source scan state...");
      mjsonrpc_db_get_values([
          "/PixelQC/Flags/source_sensor_position_adjusted",
          "/PixelQC/Flags/source_sensor_position"
      ]).then(rpc => {
          const adjusted = rpc.result.data[0];
          const position = rpc.result.data[1];
          console.log("Initial state - adjusted:", adjusted, "position:", position);
          if (adjusted === false || adjusted === 0) {
              console.log("Initial state requires intervention, calling handler");
              handleSourceScanIntervention(false);
          }
      }).catch(err => {
          console.error("Error checking initial source scan state:", err);
      });
  }, 1000);
});

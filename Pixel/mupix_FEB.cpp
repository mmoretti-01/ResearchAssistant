#include "mupix_FEB.h"
#include "midas.h"
#include "odbxx.h"
#include "mfe.h" //for set_equipment_status
#include "odbxx.h"

#include "../include/feb.h"
using namespace mu3e::daq;

#include "mudaq_device.h"
#include "mupix_config.h"
#include "mupix_MIDAS_config.h"
#include <thread>
#include <vector>
#include "reset_protocol.h"
#include "link_constants.h"
#include "mu3ebanks.h"
#include "slowcontrolbank.h"
#include "util.h"

#include "mu3ebanks.h"

#include <iostream>
#include <fstream>
#include <istream>
#include <chrono>
using midas::odb;
#include <numeric>


#include "default_config_mupix.h" //TODO avoid this, reproduce configure routine from chip dacs


int MupixFEB::FullChipInjection(uint8_t min_columns,
                                uint8_t max_columns,
                                uint8_t min_rows,
                                uint8_t max_rows,
                                uint32_t injection_pulse_duration,
                                uint32_t num_repetitions,
                                uint32_t wait_between_pulses)
{

    midas::odb MupixInjection(pixel_odb_prefix + "/Commands/MupixInjection/");
    bool flag;
    std::vector<uint8_t> columns;
    std::vector<uint8_t> rows;
    uint8_t r_column;
    uint8_t r_row;
    uint8_t increment_c;
    uint8_t increment_r;
    uint8_t break_c;
    uint8_t break_r;

    constexpr auto waitTimeAfterConfigure = std::chrono::milliseconds(1);

    // --- Remainder (overshoot) handling ---
    // length of the scanned ranges
    const uint8_t col_range = max_columns - min_columns;
    const uint8_t row_range = max_rows - min_rows;

    //
    // Injection will provide hits with the same timestamp, but the sorter can handle at most
    // 16 hits with the same timestamp before dropping the others. So we have to limit our
    // injected pixels to less than this. Vertex has one sorter per chip, but outer pixel has
    // 1 sorter for 3 chips. So if we're injecting an outer pixel chip we need to inject a
    // smaller area.
    //
    FEBTYPE firstFEBType = FEBTYPE::Unused;
    for (auto feb : febs) {
        firstFEBType = feb.GetType();
        break;
    }

    if(firstFEBType == FEBTYPE::VertexPixel)
    {   
        // For vertex we can inject up to 16 pixels at a time. We go a little lower to be safe
        // and do 4 columns of 3 rows. Note that columns are injected in pairs so we only have
        // select 2 here.
        flag = true;
        columns = std::vector<uint8_t>(2);
        rows    = std::vector<uint8_t>(3);

        r_column   = ((col_range % 4) + 1) % 4;
        r_row      = ((row_range % 3) + 1) % 3;
        increment_c = 4;
        increment_r = 3;
        break_c     = 252;
        break_r     = 247;
    }
    else if (firstFEBType == FEBTYPE::OuterPixel)
    {
        // For outer pixel we can only inject 16 pixels across 3 chips, so ~5 pixels per chip.
        // So we do 2 columns of 2 rows. Note that columns are injected in pairs so 1 selection
        // here is actually 2 columns.
        flag = false;
        columns = std::vector<uint8_t>(1);
        rows    = std::vector<uint8_t>(2);

        r_column   = ((col_range % 2) + 1) % 2;
        r_row      = ((row_range % 2) + 1) % 2;
        increment_c = 2;
        increment_r = 2;
        break_c     = 254;
        break_r     = 248;
    }
    else {
        std::cerr << "MupixFEB::FullChipInjection - couldn't determine the type of the attached FEBs. Not injecting.\n";
        return FE_SUCCESS;
    }


    // --- Main regular scan (no overshoot) ---
    // loop will break if next update will overshoot
    for (uint8_t c = min_columns; c <= max_columns - increment_c + 1 && c <= 255 - increment_c + 1; c += increment_c)
    {
        for (uint8_t r = min_rows; r <= max_rows - increment_r + 1 && r <= 249 - increment_r + 1; r += increment_r)
        {
            // ---- Fill columns ----
            for (uint8_t index = 0; index < columns.size(); ++index)
                columns[index] = c + (increment_c - 2) * index;

            // ---- Fill rows ----
            for (uint8_t index = 0; index < rows.size(); ++index)
                rows[index] = r + index;

            // ---- PRINT BEFORE CONFIGURE ----
            uint8_t col_start = columns.front();
            uint8_t col_end   = columns.back();
            uint8_t row_start = rows.front();
            uint8_t row_end   = rows.back();

            std::cout << "Configure rows " << static_cast<int>(row_start)
                      << "–" << static_cast<int>(row_end)
                      << " and cols " << static_cast<int>(col_start)
                      << "–" << static_cast<int>(col_end)
                      << std::endl;

            // ---- Actual injection ----
            ConfigureInjectASICs(columns, rows);
            std::this_thread::sleep_for(waitTimeAfterConfigure);
            InjectASICsInLoop(injection_pulse_duration, num_repetitions, wait_between_pulses);
            if (r >= break_r) break;
        }

        if (c >= break_c) break;

        if (!MupixInjection["Full chip Injection"]) 
        {
            return FE_SUCCESS;
        }
    }

    // Computes the tail columns
    std::vector<uint8_t> columns_tail;
    if (r_column == 1)
    {
        columns_tail = { max_columns};
    }
    else if (r_column == 2)
    {   
        columns_tail = { static_cast<uint8_t>(max_columns - 1) };
    }
    else if (r_column > 2)
    {   
        columns_tail = { static_cast<uint8_t>(max_columns - 2), max_columns };
    }

    // Computes the tail rows
    std::vector<uint8_t> rows_tail;
    if (r_row == 1)
    {
        rows_tail = { max_rows };
    }
    else if (r_row == 2)
    {
        rows_tail = { static_cast<uint8_t>(max_rows - 1), max_rows };
    }

    // ---------- 1) Right strip: leftover columns, full row blocks ----------
    if (r_column != 0)
    {
        for (uint8_t r = min_rows; r <= max_rows - increment_r + 1 && r <= 249 - increment_r + 1; r += increment_r)
        {
            std::vector<uint8_t> rows_block;
            if (flag)
            {
                rows_block = {r, static_cast<uint8_t>(r + 1), static_cast<uint8_t>(r + 2)};
            }
            else
            {
                rows_block = {r, static_cast<uint8_t>(r + 1)};
            }


            ConfigureInjectASICs(columns_tail, rows_block);
            std::this_thread::sleep_for(waitTimeAfterConfigure);
            InjectASICsInLoop(injection_pulse_duration, num_repetitions, wait_between_pulses);
            if (r >= break_r) break;
        }
    }

    // ---------- 2) Bottom strip: leftover rows, full column blocks ----------
    if (r_row != 0)
    {
        for (uint8_t c = min_columns;  c <= max_columns - increment_c + 1 && c <= 255 - increment_c + 1; c += increment_c)
        {
            std::vector<uint8_t> columns_block;
            if (flag)
            {
                columns_block = {c, static_cast<uint8_t>(c + 2)};
            }    
            else
            {
                columns_block = {c};
            }

            ConfigureInjectASICs(columns_block, rows_tail);
            std::this_thread::sleep_for(waitTimeAfterConfigure);
            InjectASICsInLoop(injection_pulse_duration, num_repetitions, wait_between_pulses);
            if (c >= break_c) break;
        }
    }

    // ---------- 3) Bottom-right corner: leftover rows AND columns ----------
    if (r_column != 0 && r_row != 0)
    {
        std::cout << "Tail injection (corner): rows "
                  << static_cast<int>(rows_tail.front()) << "–"
                  << static_cast<int>(rows_tail.back())
                  << " and cols "
                  << static_cast<int>(columns_tail.front()) << "–"
                  << static_cast<int>(columns_tail.back())
                  << std::endl;

        ConfigureInjectASICs(columns_tail, rows_tail);
        std::this_thread::sleep_for(waitTimeAfterConfigure);
        InjectASICsInLoop(injection_pulse_duration, num_repetitions, wait_between_pulses);
    }

    return FE_SUCCESS;
}

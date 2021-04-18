/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { flatten } from "lodash"
import dedent = require("dedent")

import {
  Command,
  CommandParams,
  CommandResult,
  handleProcessResults,
  PrepareParams,
  ProcessCommandResult,
  processCommandResultSchema,
} from "./base"
import { processModules } from "../process"
import { GardenModule } from "../types/module"
import { getTestTasks } from "../tasks/test"
import { printHeader } from "../logger/util"
import { startServer } from "../server/server"
import { StringsParameter, BooleanParameter } from "../cli/params"

export const testArgs = {
  modules: new StringsParameter({
    help:
      "The name(s) of the module(s) to test (skip to test all modules). " +
      "Use comma as a separator to specify multiple modules.",
  }),
}

export const testOpts = {
  "name": new StringsParameter({
    help:
      "Only run tests with the specfied name (e.g. unit or integ). " +
      "Accepts glob patterns (e.g. integ* would run both 'integ' and 'integration')",
    alias: "n",
  }),
  "force": new BooleanParameter({
    help: "Force re-test of module(s).",
    alias: "f",
  }),
  "force-build": new BooleanParameter({ help: "Force rebuild of module(s)." }),
  "watch": new BooleanParameter({
    help: "Watch for changes in module(s) and auto-test.",
    alias: "w",
    cliOnly: true,
  }),
}

type Args = typeof testArgs
type Opts = typeof testOpts

export class TestCommand extends Command<Args, Opts> {
  name = "test"
  help = "Test all or specified modules."

  protected = true
  workflows = true
  streamEvents = true

  description = dedent`
    Runs all or specified tests defined in the project. Also builds modules and dependencies,
    and deploys service dependencies if needed.

    Optionally stays running and automatically re-runs tests if their module source
    (or their dependencies' sources) change.

    Examples:

        garden test                   # run all tests in the project
        garden test my-module         # run all tests in the my-module module
        garden test --name integ      # run all tests with the name 'integ' in the project
        garden test --name integ*     # run all tests with the name starting with 'integ' in the project
        garden test -n unit -n lint   # run all tests called either 'unit' or 'lint' in the project
        garden test --force           # force tests to be re-run, even if they've already run successfully
        garden test --watch           # watch for changes to code
  `

  arguments = testArgs
  options = testOpts

  outputsSchema = () => processCommandResultSchema()

  private isPersistent = (opts) => !!opts.watch

  printHeader({ headerLog }) {
    printHeader(headerLog, `Running tests`, "thermometer")
  }

  async prepare({ footerLog, opts }: PrepareParams<Args, Opts>) {
    const persistent = this.isPersistent(opts)

    if (persistent) {
      this.server = await startServer({ log: footerLog })
    }

    return { persistent }
  }

  async action({
    garden,
    log,
    footerLog,
    args,
    opts,
  }: CommandParams<Args, Opts>): Promise<CommandResult<ProcessCommandResult>> {
    if (this.server) {
      this.server.setGarden(garden)
    }

    const graph = await garden.getConfigGraph(log)

    const modules: GardenModule[] = args.modules
      ? graph.withDependantModules(graph.getModules({ names: args.modules }))
      : // All modules are included in this case, so there's no need to compute dependants.
        graph.getModules()

    const filterNames = opts.name || []
    const force = opts.force
    const forceBuild = opts["force-build"]

    const initialTasks = flatten(
      await Bluebird.map(modules, (module) =>
        getTestTasks({
          garden,
          log,
          graph,
          module,
          filterNames,
          force,
          forceBuild,
          devModeServiceNames: [],
          hotReloadServiceNames: [],
        })
      )
    )

    const results = await processModules({
      garden,
      graph,
      log,
      footerLog,
      modules,
      initialTasks,
      watch: opts.watch,
      changeHandler: async (updatedGraph, module) => {
        const modulesToProcess = await updatedGraph.withDependantModules([module])
        return flatten(
          await Bluebird.map(modulesToProcess, (m) =>
            getTestTasks({
              garden,
              log,
              graph: updatedGraph,
              module: m,
              filterNames,
              force,
              forceBuild,
              devModeServiceNames: [],
              hotReloadServiceNames: [],
            })
          )
        )
      },
    })

    return handleProcessResults(footerLog, "test", results)
  }
}

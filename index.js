#!/usr/bin/env node
// lovs — LibreOffice version switcher. Entry point for the CLI; `lovs ui`
// starts the web interface (api/ + web_interface/).
import { buildProgram } from './cli/commands.js';

buildProgram().parseAsync(process.argv);

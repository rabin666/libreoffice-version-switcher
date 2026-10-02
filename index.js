#!/usr/bin/env node
// lovs — LibreOffice version switcher. CLI entry point; `lovs ui` starts the
// web interface (api/ serving web_interface/).
import { buildProgram } from './cli/program.js';

buildProgram().parseAsync(process.argv);

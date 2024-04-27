import * as fs from 'fs'
import * as io from '@actions/io'
import * as core from '@actions/core'
import { getDefaultShell, execute, pixiCmd } from './util'

type PwshEnvVar = Readonly<{
  Key: string
  Value: string
}>

const executeShellHookBash = (environment: string): Promise<number> => {
  const pixiCommand = pixiCmd('shell-hook').join(' ')
  const commands = [
    'jq -n env > ~/.setup-pixi/old-env.json',
    `eval $(${pixiCommand} -e ${environment})`,
    'jq -n env > ~/.setup-pixi/new-env.json'
  ]
  return execute(['powershell.exe', '-Command', commands.join(' && ')])
}

const executeShellHookPwsh = (environment: string): Promise<number> => {
  const pixiCommand = pixiCmd('shell-hook').join(' ')
  const commands = [
    'Get-ChildItem Env:* | ConvertTo-Json | Out-File -FilePath ~\\.setup-pixi\\old-env.json',
    `& ${pixiCommand} -e ${environment} | Invoke-Expression`,
    'Get-ChildItem Env:* | ConvertTo-Json | Out-File -FilePath ~\\.setup-pixi\\new-env.json'
  ]
  return execute(['pwsh', '-c', commands.join(' ; ')])
}

const parseEnvBash = (file: string): Record<string, string> => {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const parseEnvPwsh = (file: string): Record<string, string> => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Object.assign({}, ...raw.map((env: PwshEnvVar) => ({ [env.Key]: env.Value })))
}

const getAddedPathComponents = (oldPath: string, newPath: string): Array<string> => {
  const oldPathComponents = oldPath.split(':')
  const newPathComponents = newPath.split(':')
  return newPathComponents.filter((c) => !oldPathComponents.includes(c))
}

const getAddedEnvVars = (oldEnv: Record<string, string>, newEnv: Record<string, string>): Record<string, string> => {
  const oldEnvKeys = new Set(Object.keys(oldEnv))
  const addedEnv: Record<string, string> = {}
  for (const key in newEnv) {
    // Include new and modified env vars except 'PATH'
    if (!oldEnvKeys.has(key) || (key !== 'PATH' && oldEnv[key] !== newEnv[key])) {
      addedEnv[key] = newEnv[key]
    }
  }
  return addedEnv
}

export const activateEnvironment = async (environment: string): Promise<void> => {
  // `~/.setup-pixi` is used to write temporary files for the environment variables. It is
  // removed later
  io.mkdirP('~/.setup-pixi')

  // First, execute the pixi shell hook and record all environment variables prior and after.
  let oldEnv
  let newEnv
  const shell = getDefaultShell()
  switch (shell) {
    case 'bash':
      await executeShellHookBash(environment)
      oldEnv = parseEnvBash('~/.setup-pixi/old-env')
      newEnv = parseEnvBash('~/.setup-pixi/new-env')
      break
    case 'pwsh':
      await executeShellHookPwsh(environment)
      oldEnv = parseEnvPwsh('~/.setup-pixi/old-env')
      newEnv = parseEnvPwsh('~/.setup-pixi/new-env')
      break
  }

  // Then, find the diff between environment variables, treating `PATH` specially
  const addedPathComponents = getAddedPathComponents(oldEnv.PATH, newEnv.PATH)
  const addedEnvVars = getAddedEnvVars(oldEnv, newEnv)

  // Eventually, we can update our job environment and clean up
  for (const path in addedPathComponents) {
    core.addPath(path)
  }
  for (const envVar in addedEnvVars) {
    core.exportVariable(envVar, addedEnvVars[envVar])
  }
  io.rmRF('~/.setup-pixi')
}

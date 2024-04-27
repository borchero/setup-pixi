import * as fs from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import * as io from '@actions/io'
import * as core from '@actions/core'
import { getDefaultShell, execute, pixiCmd } from './util'

type PwshEnvVar = Readonly<{
  Key: string
  Value: string
}>

const executeShellHookBash = ({ environment, tmpPath }: { environment: string; tmpPath: string }): Promise<number> => {
  const pixiCommand = pixiCmd('shell-hook').join(' ')
  const commands = [
    `jq -n env > ${tmpPath}/old-env.json`,
    `eval $(${pixiCommand} -e ${environment})`,
    `jq -n env > ${tmpPath}/new-env.json`
  ]
  return execute(['bash', '-c', commands.join(' && ')])
}

const executeShellHookPwsh = ({ environment, tmpPath }: { environment: string; tmpPath: string }): Promise<number> => {
  const pixiCommand = pixiCmd('shell-hook').join(' ')
  const commands = [
    `Get-ChildItem Env:* | ConvertTo-Json | Out-File -FilePath ${tmpPath}\\old-env.json`,
    `& ${pixiCommand} -e ${environment} | Invoke-Expression`,
    `Get-ChildItem Env:* | ConvertTo-Json | Out-File -FilePath ${tmpPath}\\new-env.json`
  ]
  return execute(['powershell.exe', '-Command', commands.join(' ; ')])
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
  // `~/.setup-pixi` is used to write temporary files for the environment variables. It is removed later
  const tmpPath = path.join(homedir(), '.setup-pixi')
  io.mkdirP(tmpPath)

  // First, execute the pixi shell hook and record all environment variables prior and after.
  let oldEnv
  let newEnv
  const shell = getDefaultShell()
  switch (shell) {
    case 'bash':
      await executeShellHookBash({ environment, tmpPath })
      oldEnv = parseEnvBash(path.join(tmpPath, 'old-env.json'))
      newEnv = parseEnvBash(path.join(tmpPath, 'new-env.json'))
      break
    case 'pwsh':
      await executeShellHookPwsh({ environment, tmpPath })
      oldEnv = parseEnvPwsh(path.join(tmpPath, 'old-env.json'))
      newEnv = parseEnvPwsh(path.join(tmpPath, 'new-env.json'))
      break
  }

  // Then, find the diff between environment variables, treating `PATH` specially
  const addedPathComponents = getAddedPathComponents(oldEnv.PATH, newEnv.PATH)
  const addedEnvVars = getAddedEnvVars(oldEnv, newEnv)

  // Eventually, we can update our job environment and clean up
  for (const path of addedPathComponents) {
    core.info(`Adding to path: '${path}'`)
    core.addPath(path)
  }
  for (const envVar in addedEnvVars) {
    core.info(`Exporting environment variable: '${envVar}=${addedEnvVars[envVar]}'`)
    core.exportVariable(envVar, addedEnvVars[envVar])
  }
  io.rmRF(tmpPath)
}

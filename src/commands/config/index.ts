// tslint:disable no-console

import color from '@heroku-cli/color'
import { Command, flags } from '@heroku-cli/command'
import cli from 'cli-ux'
import { HTTP } from 'http-call'
import * as _ from 'lodash'
import { DateTime } from 'luxon'
import * as Rx from 'rxjs/Rx'

const shellescape = require('shell-escape')

interface APIUser {
  id: string
  email: string
}

interface APIApp {
  id: string
  name: string
}

interface APIRelease {
  addon_plan_names: string[]
  app: APIApp
  created_at: string
  // description: "Set BAR config vars",
  description: string
  status: 'succeeded'
  id: string
  slug: any
  updated_at: string
  user: APIUser
  version: number
  current: boolean
  output_stream_url: string | null
}

function relativeDate(date: Date | undefined) {
  if (!date) return color.dim('???')
  const ldate = DateTime.fromJSDate(date)
  const duration = DateTime.local()
    .diff(ldate, ['years', 'months', 'days', 'hours'])
    .toObject()

  let thisColor
  if (duration.years && duration.years > 1) thisColor = color.redBright
  else if (duration.years) thisColor = color.red
  else if (duration.months && duration.months > 6) thisColor = color.yellowBright
  else if (duration.months && duration.months > 3) thisColor = color.yellow
  else thisColor = color.green

  let s
  if (duration.years && duration.years > 1) s = `about ${duration.years} years ago`
  else if (duration.years) s = `about 1 year ago`
  else if (duration.months && duration.months > 1) s = `about ${duration.months} months ago`
  else if (duration.months) s = `about 1 month ago`
  else if (duration.days) s = `${duration.days} days ago`
  else s = 'today'
  return `${thisColor(s)} ${color.dim(ldate.toLocaleString(DateTime.DATE_SHORT))}`
}

export default class ConfigIndex extends Command {
  static description = 'display the config vars for an app'
  static flags = {
    app: flags.app({ required: true }),
    remote: flags.remote(),
    'last-updated': flags.boolean({ description: 'get the last updated time of each config var' }),
    shell: flags.boolean({ char: 's', description: 'output config vars in shell format' }),
    json: flags.boolean({ description: 'output config vars in json format' }),
  }

  async run() {
    let { body: configVars } = await this.heroku.get(`/apps/${this.flags.app}/config-vars`)
    if (this.flags['last-updated']) return this.lastUpdated(configVars)
    if (this.flags.shell) {
      _.forEach(configVars, (v: string, k: string) => {
        cli.log(`${k}=${shellescape([v])}`)
      })
    } else if (this.flags.json) {
      cli.styledJSON(configVars)
    } else {
      cli.styledHeader(`${this.flags.app} Config Vars`)
      cli.styledObject(_.mapKeys(configVars, (_, k) => color.configVar(k as any)))
    }
  }

  async lastUpdated(configVars: { [k: string]: string }) {
    const cmd = this

    const releases$: Rx.Observable<APIRelease> = (() => {
      const next = (last?: HTTP): Rx.Observable<HTTP> => {
        if (last && !last.headers['next-range']) return Rx.Observable.empty()
        const p = cmd.heroku.get(`/apps/${cmd.flags.app}/releases`, {
          partial: true,
          headers: { range: (last && last.headers['next-range']) || 'version ..; max=15, order=desc' },
        })
        return Rx.Observable.fromPromise(p)
      }

      return next()
        .expand(cur => next(cur))
        .concatMap(cur => cur.body as APIRelease[])
        .publishReplay()
        .refCount()
    })()

    function configLastUpdated(key: string): Rx.Observable<Date | null> {
      return releases$
        .map(release => {
          let match = release.description.match(/^Set ((?:\w+(?:, )?)+) config var/) as [string, string]
          if (!match) match = release.description.match(/^Update ((?:\w+(?:, )?)+) by/) as [string, string]
          if (!match)
            match = release.description.match(/^Attach ((?:\w+(?:, )?)+) (?:resource|\(@ref:)/) as [string, string]
          // if (match) console.dir([match[0], match[1]])
          // else console.dir(release.description)
          let configVars: string[] = []
          if (match) configVars = match[1].split(',').map(s => s.trim())
          return {
            release,
            configVars,
          }
        })
        .first(
          r => {
            for (let k of r.configVars) {
              if (k === key) return true
              if (`${k}_URL` === key) return true
            }
            return false
          },
          r => new Date(r.release.created_at || r.release.updated_at) as any,
          null,
        )
    }

    await Rx.Observable.from(Object.entries(configVars))
      .mergeMap(([key]) => configLastUpdated(key), ([key, value], lastUpdated) => ({ key, value, lastUpdated }))
      .reduce((arr, config) => arr.concat([config]), [])
      .do(v => {
        cli.table(_.sortBy(v, 'key'), {
          printHeader: false,
          columns: [
            { key: 'key' },
            // {key: 'value'},
            { key: 'lastUpdated', format: relativeDate },
          ],
        })
      })
      .toPromise()
  }
}

var ImageWriter = require('./writer')
var request = require('request')
var drivelist = require('drivelist')
var debug = require('debug')('multiwrite')
var fs = require('fs')
var path = require('path')
var EventEmitter = require('events')
var mountutils = require('mountutils')
var MBR = require('mbr')

var IMAGE_URL = process.env.IMAGE_URL

var IMAGE_DATA_DIR = process.env.IMAGE_DATA_DIR ?
  process.env.IMAGE_DATA_DIR : '/data'

var DRIVE_BLACKLIST = process.env.DRIVE_BLACKLIST ?
  process.env.DRIVE_BLACKLIST.split(',') : null

debug( 'IMAGE_URL', IMAGE_URL )
debug( 'IMAGE_DATA_DIR', IMAGE_DATA_DIR )
debug( 'DRIVE_BLACKLIST', DRIVE_BLACKLIST )

class Hub extends EventEmitter {

  constructor() {

    super()

    this.processes = new Map()
    this.blacklist = DRIVE_BLACKLIST || []

    this.running = true
    this.imageSize = null
    this.filename = null

    this.once( 'ready', () => {
      debug( 'ready' )
      this.start()
      this.scan()
    })

    // Download image and then start flashing
    this.fetch()

  }

  scan() {
    debug( 'scan' )
    drivelist.list(( error, drives ) => {
      if( error ) throw error
      drives = drives.filter(( drive ) => {
        return !~this.blacklist.indexOf( drive.device ) &&
          drive.system === false &&
          drive.protected === false &&
          !/mac/i.test(drive.description)
      })
      debug( 'drives %O', error || drives )
      this.update(drives)
      if( this.running ) {
        this.scan()
      }
    })
  }

  fetch() {

    this.filename = path.join( IMAGE_DATA_DIR, path.basename( IMAGE_URL ) )

    debug( 'fetch', this.filename )

    try {
      var stats = fs.statSync( this.filename )
      if( stats.isFile() ) {
        this.imageSize = fs.statSync( this.filename ).size
        debug( 'fetch:exists' )
        this.emit( 'ready' )
        return
      }
    } catch( error ) {
      debug( 'fetch:download' )
    }

    var dest = fs.createWriteStream( this.filename )
    var onError = ( error ) => { this.emit( 'error', error ) }

    request( IMAGE_URL )
      .on( 'error', onError )
      .pipe( dest )
      .on( 'error', onError )
      .once( 'finish', () => {
        debug( 'finish' )
        this.imageSize = fs.statSync( this.filename ).size
        this.emit( 'ready' )
      })

  }

  start() {
    debug( 'start' )
  }

  flash(drive) {

    if( this.processes.has( drive.device ) ) {
      var proc = this.processes.get( drive.device )
      debug( 'update:bail', proc.drive )
      return
    }

    var proc = new Process()
    var image = {
      stream: fs.createReadStream( this.filename ),
      size: {
        original: this.imageSize,
        final: {
          estimation: false,
          value: this.imageSize,
        },
      },
    }

    proc.drive = drive

    var onUnmount = () => {

      proc.fd = fs.openSync( drive.raw, 'rs+' )
      proc.writer = new ImageWriter({
        image: image,
        fd: proc.fd,
        path: drive.raw,
        verify: true,
        checksumAlgorithms: [ 'crc32' ]
      })

      proc.writer
        .on( 'progress', (state) => {
          debug( 'progress', state )
        })
        .on( 'finish', () => {
          debug( 'finish' )
          fs.closeSync( proc.fd )
          mountutils.unmountDisk( drive.device, (error) => {
            debug( 'unmount:finish', error || `OK ${proc.drive.device}` )
            if( error ) throw error
            setTimeout(() => {
              this.processes.delete( drive.device )
            }, 10e3)
          })
        })

    }

    this.processes.set( drive.device, proc )

    mountutils.unmountDisk( drive.device, (error) => {
      debug( 'start:unmount', error || `OK ${proc.drive.device}` )
      if( error ) throw error
      onUnmount()
      process.nextTick(() => {
        proc.writer.write()
      })
    })

  }

  update(drives) {

    const nextDrive = () => {
      const drive = drives.shift()
      if( drive != null ) {
        this.flash(drive)
        process.nextTick(nextDrive)
      }
    }

    nextDrive()

  }

}

class Process {

  constructor() {
    this.drive = null
    this.writer = null
  }

}

var hub = new Hub()

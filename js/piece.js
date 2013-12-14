function Piece(opts) {
    jstorrent.Item.apply(this, arguments)
    this.torrent = opts.torrent
    this.num = opts.num
    this.size = this.torrent.getPieceSize(this.num)
    this.numChunks = Math.ceil(this.size / jstorrent.protocol.chunkSize)
    this.set('requests', 0)
    this.set('responses', 0)
    this.set('timeouts', 0)
    this.resetData()
    this.wasReset = false
}
jstorrent.Piece = Piece
Piece.prototype = {
    resetData: function() {
        // able to store multiple copies of chunk responses,
        // per each peer this serves endgame mode. we can
        // attempt to hash-check a complete piece that is not
        // homogenous in a single peer, but rather contains
        // data from multiple peers.
        this.wasReset = true
        this.chunkRequests = {} // keep track of chunk requests
        this.chunkResponses = {}
        this.chunkResponsesChosen = null
        this.chunkResponsesChosenPlain = null
        this.data = null
        this.haveData = false
        this.haveValidData = false
        // haveData is not the same as having written the data to disk... ?
        this.haveDataPersisted = false
        // this means we actually successfully wrote it to disk
    },
    get_key: function() {
        return this.num
    },
    registerChunkResponseFromPeer: function(peerconn, chunkOffset, data) {
        this.set('responses', this.get('responses')+1)
        var chunkNum = chunkOffset / jstorrent.protocol.chunkSize
        // received a chunk response from peer
        // decrements this peer connection's request counter

        //console.log("Chunk response from peer!", this.num, chunkNum)
        var handled = false

        if (this.chunkRequests[chunkNum]) {
            for (var i=0; i<this.chunkRequests[chunkNum].length; i++) {
                if (this.chunkRequests[chunkNum][i].peerconn == peerconn) {
                    handled = true
                    break
                }
            }
        }

        if (handled) {
            peerconn.outstandingPieceChunkRequestCount--

            // clearing these out creates lots of problems, because we keep making more requests to the same shit...
/*
            this.chunkRequests[chunkNum].splice(i,1)
            if (this.chunkRequests[chunkNum].length == 0) {
                delete this.chunkRequests[chunkNum]
            }
*/
            if (! this.chunkResponses[chunkNum]) {
                this.chunkResponses[chunkNum] = []
            }

            this.chunkResponses[chunkNum].push( {data:data,
                                                 peerconn:peerconn} )
            var filled = this.checkChunkResponsesFilled();

            if (filled) {
                this.checkChunkResponseHash( null, _.bind(function(valid) {
                    if (valid) {
                        console.log('hashchecked valid piece',this.num)
                        // perhaps also place in disk cache?
                        this.data = new Uint8Array(this.size)
                        var curData, curOffset=0

                        for (var i=0; i<this.chunkResponsesChosen.length; i++) {
                            curData = this.chunkResponsesChosen[i].data
                            this.data.set(curData, curOffset)
                            curOffset += curData.length
                        }
                        this.data = this.data.buffer
                        this.haveData = true
                        this.torrent.persistPiece(this)
                    } else {
                        console.error('either unable to hash piece due to worker error, or hash mismatch')

                        // first of all, throw away this piece's data entirely...

                        // what to do, mark a peer as nasty, mark as suspect?
                        debugger
                    }
                },this))
            }
        } else {
            // request had timed out
        }
    },
    notifyPiecePersisted: function() {
        // maybe do some other stuff, like send CANCEL message to any other peers

        // now destroy my data
        this.resetData()
        this.haveDataPersisted = true
        this.torrent.pieces.remove(this)
    },
    checkChunkResponseHash: function(preferredPeer, callback) {
        // TODO - allow this to prefer assembling from a specific peer

        // the actual digest happens in the thread

        var responses, curChoice
        //var digest = new Digest.SHA1()
        this.chunkResponsesChosen = []
        this.chunkResponsesChosenPlain = [] // without peer
        for (var i=0; i<this.numChunks; i++) {
            responses = this.chunkResponses[i]
            curChoice = responses[0] // for now just grab the first response for this chunk received
            //digest.update(curChoice.data)
            this.chunkResponsesChosen.push( curChoice )
            this.chunkResponsesChosenPlain.push( curChoice.data )
        }

        var worker = this.torrent.client.workerthread
        if (worker.busy) {
            console.warn('worker busy indicates we should have more than one thread')
            // TODO -- # worker threads, perhaps show a warning, and
            // in the options page, optional permission to get CPU
            // info and adjust number of workers debugger
        }
        worker.send( { chunks: this.chunkResponsesChosenPlain,
                       command: 'hashChunks' },
                     _.bind(function(result) {
                         if (result && result.hash) {

                             var responseHash = ui82str(result.hash)
                             if (responseHash == this.torrent.infodict.pieces.slice( this.num * 20, (this.num+1)*20 )) {
                                 //console.log('%cGOOD PIECE RECEIVED!', 'background:#33f; color:#fff',this.num)
                                 callback(true)
                             } else {
                                 this.chunkResponsesChosenPlain = null
                                 console.log('%cBAD PIECE RECEIVED!', 'background:#f33; color:#fff',this.num)
                                 callback(false)
                             }

                         } else {
                             console.error('error with sha1 hashing worker thread')
                             callback(false)
                         }

                     },this));

    },
    checkChunkResponsesFilled: function() {
        for (var i=0; i<this.numChunks; i++) {
            if (! this.chunkResponses[i] ||
                this.chunkResponses[i].length == 0)
            {
                return false
            }
        }
        return true
    },
    unregisterAllRequestsForPeer: function(peerconn) {

        for (var chunkNum in this.chunkRequests) {
            //requests = this.chunkRequests[chunkNum]
            this.chunkRequests[chunkNum] = _.filter(this.chunkRequests[chunkNum], function(v) { return v.peerconn != peerconn })
            for (var i=0; i<requests.length; i++) {
debugger
            }
            
        }
    },
    checkChunkTimeouts: function(chunkNums) {
        if (this.haveData || this.haveDataPersisted) { return }
        console.log('piece',this.num,'checkChunkTimeouts',chunkNums)
        var chunksWithoutResponses = []
        var chunkNum, requests, responses, requestData, responseData, foundResponse
        //var curTime = new Date()
        for (var i=0; i<chunkNums.length; i++) {
            chunkNum = chunkNums[i]
            if (this.chunkRequests[chunkNum]) {
                requests = this.chunkRequests[chunkNum]
                responses = this.chunkResponses[chunkNum]

                for (var j=0; j<requests.length; j++) {
                    requestData = requests[j]

                    if (! responses) {
                        foundResponse = false
                        // definitely timeout
                    } else {
                        foundResponse = false
                        for (var k=0; k<responses.length; k++) {
                            responseData = responses[k]
                            if (requestData.peerconn == responseData.peerconn) {
                                foundResponse = true
                            }
                        }
                    }
                    // checking the timestamp makes no sense. we set the timeout timestamp, duh.
                    //if (curTime - requestData.time >= jstorrent.constants.chunkRequestTimeoutInterval) {
                    if (! foundResponse) {
                        this.set('timeouts',this.get('timeouts')+1)
                        delete this.chunkRequests[chunkNum] // XXX this is too greedy. it removes a request to another peer too.
                        // this code doesn't actually handle requests to multiple peers for the same piece... it just pretends to :-(
                    }
                }
            }
        }



    },
    registerChunkRequestForPeer: function(peerconn, chunkNum, chunkOffset, chunkSize) {
        this.set('requests', this.get('requests')+1)
        //peerconn.registerChunkRequest(this.num, chunkNum, chunkOffset, chunkSize)
        if (this.chunkRequests[chunkNum] === undefined) {
            this.chunkRequests[chunkNum] = []
        }
        this.chunkRequests[chunkNum].push( {time: new Date(), peerconn:peerconn} )
    },
    getChunkRequestsForPeer: function(howmany, peerconn) {
        // returns up to howmany chunk requests
        // need special handling for very last piece of a torrent
        //console.log('getChunkRequestsForPeer')

        var chunkNum = 0
        var chunkOffset = 0
        var chunkSize = jstorrent.protocol.chunkSize
        var obtained = 0
        var payload, v
        var payloads = []
        var chunkNums = []

        while (chunkOffset < this.size && obtained < howmany) {
            // TODO -- make this loop more efficient
            //console.log('inwhile',this.num,chunkNum,chunkOffset,obtained,payloads)
            if (chunkNum == this.numChunks - 1 &&
                this.num == this.torrent.numPieces - 1) {
                // very last chunk of torrent has special size
                chunkSize = this.size - chunkNum * chunkSize
            }

            if (this.chunkRequests[chunkNum] || this.chunkResponses[chunkNum]) {
                // if ENDGAME, analyze further.
                if (this.torrent.isEndGame) {
                    debugger
                }
            } else {
                obtained++
                this.registerChunkRequestForPeer(peerconn, chunkNum, chunkOffset, chunkSize)
                chunkNums.push(chunkNum)
                payload = new Uint8Array(12)
                v = new DataView(payload.buffer)
                v.setUint32(0, this.num)
                v.setUint32(4, chunkOffset)
                v.setUint32(8, chunkSize)
                payloads.push( payload.buffer )
            }
            chunkNum++
            chunkOffset += jstorrent.protocol.chunkSize
        }
        setTimeout( _.bind(this.torrent.checkPieceChunkTimeouts,this.torrent,this.num,chunkNums), jstorrent.constants.chunkRequestTimeoutInterval )
        return payloads
    },
    getSpanningFilesInfo: function(offset, size) {
        // returns a list of [fileNum, fileOffset, size]
        if (offset === undefined) { offset = 0 }
        if (size === undefined) { size = this.size }

        var startByte = this.torrent.pieceLength * this.num + offset
        var endByte = this.torrent.pieceLength * this.num + offset + size - 1

        var infos = []

        var idx = bisect_right(this.torrent.fileOffsets, startByte)
        var curFileNum = idx-1
        var curFileStartByte, curFileEndByte
        while (curFileNum < this.torrent.numFiles) {
            curFileStartByte = this.torrent.fileOffsets[curFileNum]

            if (curFileNum == this.torrent.numFiles - 1) {
                curFileEndByte = this.torrent.size - 1
            } else {
                curFileEndByte = this.torrent.fileOffsets[curFileNum + 1] - 1
            }
            var intersection = intersect( curFileStartByte, curFileEndByte,
                                          startByte, endByte )
            if (intersection) {
                var intersectionStart = intersection[0]
                var intersectionEnd = intersection[1]
                var info = {fileNum: curFileNum,
                             pieceOffset: intersectionStart - startByte,
                             fileOffset: intersectionStart - curFileStartByte,
                             size: intersectionEnd - intersectionStart + 1}
                //console.log(this.num, 'got spanning file info', info)
                infos.push( info )
                curFileNum++
            } else {
                break
            }
        }
        console.assert(infos.length > 0)
        return infos
    },
    getSpanningFilesData: function(offset, size, callback) {
        // spawns diskIO for retreiving actual data from the disk

        var filesSpanInfo = this.getSpanningFilesInfo()
        // create a bunch of diskio jobs

        this.torrent.diskio.readPiece(this, offset, size, function(data) {
            debugger
        })

    }
}
for (var method in jstorrent.Item.prototype) {
    jstorrent.Piece.prototype[method] = jstorrent.Item.prototype[method]
}

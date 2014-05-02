#!/usr/bin/env node
"use strict";
/**
 * A client for testing round-tripping of articles.
 */

var express = require( 'express' ),
	optimist = require( 'optimist' );

// Default options
var defaults = {
	'host': 'localhost',
	'port': 3306,
	'database': 'parsoid',
	'user': 'parsoid',
	'password': 'parsoidpw',
	'debug': false,
	'fetches': 6,
	'tries': 6,
	'cutofftime': 600,
	'batch': 50
};


// Command line options
var argv = optimist.usage( 'Usage: $0 [connection parameters]' )
	.options( 'help', {
		'boolean': true,
		'default': false,
		describe: "Show usage information."
	} )
	.options( 'h', {
		alias: 'host',
		describe: 'Hostname of the database server.'
	} )
	.options( 'P', {
		alias: 'port',
		describe: 'Port number to use for connection.'
	} )
	.options( 'D', {
		alias: 'database',
		describe: 'Database to use.'
	} )
	.options( 'u', {
		alias: 'user',
		describe: 'User for MySQL login.'
	} )
	.options( 'p', {
		alias: 'password',
		describe: 'Password.'
	} )
	.options( 'd', {
		alias: 'debug',
		'boolean': true,
		describe: "Output MySQL debug data."
	} )
	.options( 'f', {
		alias: 'fetches',
		describe: "Number of times to try fetching a page."
	} )
	.options( 't', {
		alias: 'tries',
		describe: "Number of times an article will be sent for testing " +
			"before it's considered an error."
	} )
	.options( 'c', {
		alias: 'cutofftime',
		describe: "Time in seconds to wait for a test result."
	} )
	.options( 'config', {
		describe: "Config file path"
	} )
	.options( 'b', {
		alias: 'batch',
		describe: "Number of titles to fetch from database in one batch."
	} )
	.argv;

if ( argv.help ) {
	optimist.showHelp();
	process.exit( 0 );
}

// Settings file
var settings;
try {
	var settingsPath = argv.config || './server-mysql.settings.js';
	settings = require( settingsPath );
} catch ( e ) {
	settings = {};
}

var getOption = function( opt ) {
	var value;

	// Check possible options in this order: command line, settings file, defaults.
	if ( argv.hasOwnProperty( opt ) ) {
		value = argv[ opt ];
	} else if ( settings.hasOwnProperty( opt ) ) {
		value = settings[ opt ];
	} else if ( defaults.hasOwnProperty( opt ) ) {
		value = defaults[ opt ];
	} else {
		return undefined;
	}

	// Check the boolean options, 'false' and 'no' should be treated as false.
	// Copied from mediawiki.Util.js.
	if ( opt === 'debug' ) {
		if ( ( typeof value ) === 'string' &&
		     /^(no|false)$/i.test( value ) ) {
			return false;
		}
	}
	return value;
};

var // The maximum number of tries per article
	maxTries = getOption( 'tries' ),
	// The maximum number of fetch retries per article
	maxFetchRetries = getOption( 'fetches' ),
	// The time to wait before considering a test has failed
	cutOffTime = getOption( 'cutofftime' ),
	// The number of pages to fetch at once
	batchSize = getOption( 'batch' ),
	debug = getOption( 'debug' );

var mysql = require( 'mysql' );
var db = mysql.createConnection({
	host     : getOption( 'host' ),
	port     : getOption( 'port' ),
	database : getOption( 'database' ),
	user     : getOption( 'user' ),
	password : getOption( 'password'),
	multipleStatements : true,
	charset  : 'UTF8_BIN',
	debug    : debug
} );

var queues = require( 'mysql-queues' );
queues( db, debug );

// Try connecting to the database.
process.on( 'exit', function() {
	db.end();
} );
db.connect( function( err ) {
	if ( err ) {
		console.error( "Unable to connect to database, error: " + err.toString() );
		process.exit( 1 );
	}
} );


var dbGetResultWithCommit =
    'SELECT result FROM results ' +
    'JOIN pages ON pages.id = results.page_id ' +
    'WHERE results.commit_hash = ? AND pages.title = ? AND pages.prefix = ?';

var dbGetTitle =
	'SELECT title, prefix' +
	'FROM pages ' +
	'WHERE id = ? ';
	// Stop other transactions from reading until we finish this one.

var dbCommits =
	'SELECT hash, timestamp ' +
	//// get the number of fixes column
	//	'(SELECT count(*) ' +
	//	'FROM pages ' +
	//		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	//		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	//	'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
	//		'AND s2.commit_hash = c1.hash AND s1.score < s2.score) as numfixes, ' +
	//// get the number of regressions column
	//	'(SELECT count(*) ' +
	//	'FROM pages ' +
	//		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	//		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	//	'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
	//		'AND s2.commit_hash = c1.hash AND s1.score > s2.score) as numregressions, ' +
	//// get the number of tests for this commit column
		// '(select count(*) from stats where stats.commit_hash = c1.hash) as numtests ' +
	'FROM commits c1 ' +
	'ORDER BY timestamp DESC';

var http = require( 'http' ),
	request = require('request'),
	cluster = require('cluster'),
	qs = require( 'querystring' ),
	exec = require( 'child_process' ).exec,
	apiServer = require( '../apiServer.js' ),
	Util = require('../../lib/mediawiki.Util.js').Util,

	commit, ctime,
	lastCommit, lastCommitTime, lastCommitCheck,
	repoPath = __dirname,

	config = require( process.argv[2] || './config.js' ),
	parsoidURL = config.parsoidURL,
	rtTest = require( '../roundtrip-test.js' );

var testsRun = 0;
var currentCommit; 
var commitIndex = 1;


var getTitle = function( cb ) {
	// console.log("get title");
	var requestOptions = {
		uri: 'http://' + config.server.host + ':' +
			config.server.port + '/title?commit=' + commit + '&ctime=' + encodeURIComponent( ctime ),
		method: 'GET'
	},
	retries = 10;

	var callback = function ( error, response, body ) {
		if (error || !response) {
			setTimeout( function () { cb( 'start' ); }, 15000 );
		}

		var resp;
		switch ( response.statusCode ) {
			case 200:
				resp = JSON.parse( body );
				cb( 'runTest', resp.prefix, resp.title );
				break;
			case 404:
				console.log( 'The server doesn\'t have any work for us right now, waiting half a minute....' );
				setTimeout( function () { cb( 'start' ); }, 30000 );
				break;
			case 426:
				console.log( "Update required, exiting." );
				// Signal our voluntary suicide to the parent if running as a
				// cluster worker, so that it does not restart this client.
				// Without this, the code is never actually updated as a newly
				// forked client will still run the old code.
				if (cluster.worker) {
					cluster.worker.kill();
				} else {
					process.exit( 0 );
				}
				break;
			default:
				console.log( 'There was some error (' + response.statusCode + '), but that is fine. Waiting 15 seconds to resume....' );
				setTimeout( function () { cb( 'start' ); }, 15000 );
		}
	};

	Util.retryingHTTPRequest(10, requestOptions, callback );
};

var runTest = function( cb, prefix, title ) {

	// console.log("run test");
	// var results, callback = rtTest.cbCombinator.bind( null, rtTest.xmlFormat, function ( err, results ) {
	// 	if ( err ) {
	// 		console.log( 'ERROR in ' + prefix + ':' + title + ':\n' + err + '\n' + err.stack);
			
	// 		 // * If you're looking at the line below and thinking "Why in the
	// 		 // * hell would they have done that, it causes unnecessary problems
	// 		 // * with the clients crashing", you're absolutely right. This is
	// 		 // * here because we use a supervisor instance to run our test
	// 		 // * clients, and we rely on it to restart dead'ns.
	// 		 // *
	// 		 // * In sum, easier to die than to worry about having to reset any
	// 		 // * broken application state.
			 
	// 		cb( 'postResult', err, results, prefix, title, function () { process.exit( 1 ); } );
	// 	} else {
	// 		cb( 'postResult', err, results, prefix, title, null );
	// 	}
	// } );

	// try {
	// 	rtTest.fetch( title, callback, {
	// 		setup: config.setup,
	// 		prefix: prefix,
	// 		editMode: false,
	// 		parsoidURL: parsoidURL
	// 	} );
	// } catch ( err ) {
	// 	// Log it to console (for gabriel to watch scroll by)
	// 	console.error( "ERROR in " + prefix + ':' + title + ': ' + err );

	// 	results = rtTest.xmlFormat( {
	// 		page: { name: title },
	// 		wiki: { iwp: prefix }
	// 	}, err );
	// 	cb( 'postResult', err, results, prefix, title, function() { process.exit( 1 ); } );
	// }

	// TODO: Query to MySQL dump for result with commit = commit, and test = test. return result.
	testsRun++;
	console.log(testsRun);

	// console.log(currentCommit);
	// console.log(title);
	// console.log(prefix);

	db.query( dbGetResultWithCommit, [ currentCommit[0], title, prefix ], function (err, results) {
		if (err) {
			console.log(err);
		} else {
			if (results[0] == null) {
				cb ('postResult', err, '', prefix, title, null);
			} else {
				cb( 'postResult', err, results[0].result, prefix, title, null );
			}
		}
	});

};


/**
 * Get the current git commit hash.
 */
var getGitCommit = function( cb ) {
	// 

	// var now = Date.now();

	// if ( !lastCommitCheck || ( now - lastCommitCheck ) > ( 5 * 60 * 1000 ) ) {
	// 	lastCommitCheck = now;
	// 	exec( 'git log --max-count=1 --pretty=format:"%H %ci"', { cwd: repoPath }, function ( err, data ) {
	// 		var cobj = data.match( /^([^ ]+) (.*)$/ );
	// 		lastCommit = cobj[1];
	// 		// convert the timestamp to UTC
	// 		lastCommitTime = new Date(cobj[2]).toISOString();
	// 		//console.log( 'New commit: ', cobj[1], lastCommitTime );
	// 		cb( cobj[1], lastCommitTime );
	// 	} );
	// } else {
	// 	cb( lastCommit, lastCommitTime );
	// }

	// TODO: Keep count of how many tests for current commit we've done, once we've tested all everything, go to next commit.
	// console.log("get git commit");
	var TotalTests = 160607;
	// console.log(currentCommit);
	if (currentCommit == null) {
		console.log("init-ing stuff");
		currentCommit = commitsList.pop();
		console.time("timing");
	}

	if (TotalTests == testsRun) {
		// return next commit;
		currentCommit = commitsList.pop();
		testsRun = 0;

	//	if (commitIndex % 10 == 0) {
			console.timeEnd("timing");
			console.time("timing");
	//	}

		commitIndex++;
	}
	
	// console.log(currentCommit);
	cb(currentCommit[0], currentCommit[1]);
};

var postResult = function( err, result, prefix, title, finalCB, cb ) {
	getGitCommit( function ( newCommit, newTime ) {
		if ( err ) {
			result =
				'<error type="' + err.name + '">' +
				err.toString() +
				'</error>';
		}

		result = qs.stringify( { results: result, commit: newCommit, ctime: newTime } );

		var requestOptions = {
			host: config.server.host,
			port: config.server.port,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': result.length
			},
			path: '/result/' + encodeURIComponent( title ) + '/' + prefix,
			method: 'POST'
		};

		var req = http.request( requestOptions, function ( res ) {
			res.on( 'end', function () {
				if ( finalCB ) {
					finalCB();
				} else {
					cb( 'start' );
				}
			} );
			res.resume();
		} );

		req.write( result, 'utf8' );
		req.end();
	} );
};

var callbackOmnibus = function(which) {
	var args = Array.prototype.slice.call(arguments);
	var prefix, title;
	switch ( args.shift() ) {
		case 'runTest':
			prefix = args[0]; title = args[1];
			// console.log( 'Running a test on', prefix + ':' + title, '....' );
			args.unshift( callbackOmnibus );
			runTest.apply( null, args );
			break;

		case 'postResult':
			prefix = args[2]; title = args[3];
			// console.log( 'Posting a result for', prefix + ':' + title, '....' );
			args.push( callbackOmnibus );
			postResult.apply( null, args );
			break;

		case 'start':
			getGitCommit( function ( latestCommit ) {
				if ( latestCommit !== commit ) {
					console.log( 'Exiting because the commit hash changed' );
					process.exit( 0 );
				}

				getTitle( callbackOmnibus );
			} );
			break;

		default:
			console.assert(false, 'Bad callback argument: '+which);
	}
};

var commitsList = [];

// TODO: get list of commits from mysql dump
db.query( dbCommits, null, function ( err, rows ) {
		if ( err ) {
			console.error( err );
		} else {
			var n = rows.length;
			for (var i = 0; i < n; i++) {
				var row = rows[i];
				var tableRow = [row.hash, row.timestamp];
				commitsList.push(tableRow);
			}
		}
		console.log(commitsList[0][0]);


		if ( typeof module === 'object' ) {
			module.exports.getTitle = getTitle;
			module.exports.runTest = runTest;
			module.exports.postResult = postResult;
		}

		if ( module && !module.parent ) {
			var getGitCommitCb = function ( commitHash, commitTime ) {
				commit = commitHash;
				ctime = commitTime;
				callbackOmnibus('start');
			};

		    // Enable heap dumps in /tmp on kill -USR2.
		    // See https://github.com/bnoordhuis/node-heapdump/
		    // For node 0.6/0.8: npm install heapdump@0.1.0
		    // For 0.10: npm install heapdump
		    process.on('SIGUSR2', function() {
		        var heapdump = require('heapdump');
		        console.error('SIGUSR2 received! Writing snapshot.');
		        process.chdir('/tmp');
		        heapdump.writeSnapshot();
		    });

			if ( !config.parsoidURL ) {
				// If no Parsoid server was passed, start our own
				parsoidURL = apiServer.startParsoidServer( function( url ) {
					parsoidURL = url;
					getGitCommit( getGitCommitCb );
				} );
			} else {
				getGitCommit( getGitCommitCb );
			}
		}

	} );



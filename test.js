* BEGIN- Helper functions for GET_regressions*/
var displayPageList = function(res, data, makeRow, err, rows){
    console.log( "GET " + data.urlPrefix + "/" + data.page + data.urlSuffix );
    if ( err ) {
        res.send( err.toString(), 500 );
    } else if ( !rows || rows.length <= 0 ) {
        res.send( "No entries found", 404 );
    } else {
        var tableRows = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var tableRow = {status: pageStatus(row), tableData: makeRow(row)};
            // console.log("table: " + JSON.stringify(tableRow, null, '\t'));
            tableRows.push(tableRow);
        }

        var tableData = data;
        tableData.paginate = true;
        tableData.row = tableRows;
        tableData.prev = data.page > 0;
        tableData.next = rows.length === 40;

        hbs.registerHelper('prevUrl', function (urlPrefix, urlSuffix, page) {
            return urlPrefix + "/" + ( page - 1 ) + urlSuffix;
        });
        hbs.registerHelper('nextUrl', function (urlPrefix, urlSuffix, page) {
            return urlPrefix + "/" + ( page + 1 ) + urlSuffix;
        });

        // console.log("JSON: " + JSON.stringify(tableData, null, '\t'));
        res.render('table.html', tableData);
    }
};

var pageTitleData = function(row){
    var parsed = JSON.parse(row.test);
    var prefix = encodeURIComponent( parsed.prefix ),
    title = encodeURIComponent( parsed.title );
    return {
        prefix: parsed.prefix,
        title: parsed.prefix + ':' + parsed.title,
        titleUrl: 'http://parsoid.wmflabs.org/_rt/' + prefix + '/' + title,
        lh: 'http://localhost:8000/_rt/' + prefix + '/' + title,
        latest: '/latestresult/' + prefix + '/' + title,
        perf: '/pageperfstats/' + prefix + '/' + title
    };
};

    return [
        pageTitleData(row),
        commitLinkData(row.new_commit, row.title, row.prefix),
        row.errors + "|" + row.fails + "|" + row.skips,
        commitLinkData(row.old_commit, row.title, row.prefix),
        row.old_errors + "|" + row.old_fails + "|" + row.old_skips
    ];
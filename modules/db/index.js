const {Pool} = require("pg");

if(!process.env.CONNECTION_STRING){
    throw new Error("No connection string provided");
}

const pool = new Pool({
    connectionString:process.env.CONNECTION_STRING
});

const db = {
    query(text, params){
        return pool.query(text, params);
    },
};

exports.db = db;
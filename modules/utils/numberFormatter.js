function formatter(number,type="number") {
    if(!number || !+number) return 0;
    const types = [
        {name:'currency',options:{style: 'currency', currency: 'USD'}},
        {name:'percent',options:{style: 'percent'}},
        {name:'number',options:{style: 'decimal'}},
    ];
    let formatter = new Intl.NumberFormat('en-US', types.find(t => t.name === type).options);
    return formatter.format(number);
}

exports.formatter = formatter;
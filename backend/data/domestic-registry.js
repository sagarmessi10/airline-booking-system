const airports = [
  { iata: "BDP", name: "Bhadrapur Airport", city: "Bhadrapur", province: "Koshi" },
  { iata: "BHR", name: "Bharatpur Airport", city: "Bharatpur", province: "Bagmati" },
  { iata: "BIR", name: "Biratnagar Airport", city: "Biratnagar", province: "Koshi" },
  { iata: "BWA", name: "Gautam Buddha International Airport", city: "Bhairahawa", province: "Lumbini" },
  { iata: "DHI", name: "Dhangadhi Airport", city: "Dhangadhi", province: "Sudurpashchim" },
  { iata: "IMK", name: "Simikot Airport", city: "Simikot", province: "Karnali" },
  { iata: "JKR", name: "Janakpur Airport", city: "Janakpur", province: "Madhesh" },
  { iata: "JMO", name: "Jomsom Airport", city: "Jomsom", province: "Gandaki" },
  { iata: "JUM", name: "Jumla Airport", city: "Jumla", province: "Karnali" },
  { iata: "KEP", name: "Nepalgunj Airport", city: "Nepalgunj", province: "Lumbini" },
  { iata: "KTM", name: "Tribhuvan International Airport", city: "Kathmandu", province: "Bagmati" },
  { iata: "LUA", name: "Tenzing-Hillary Airport", city: "Lukla", province: "Koshi" },
  { iata: "PKR", name: "Pokhara International Airport", city: "Pokhara", province: "Gandaki" },
  { iata: "SIF", name: "Simara Airport", city: "Simara", province: "Madhesh" },
  { iata: "SKH", name: "Surkhet Airport", city: "Surkhet", province: "Karnali" },
  { iata: "TMI", name: "Tumlingtar Airport", city: "Tumlingtar", province: "Koshi" },
];

const airlines = [
  { iata: "U4", name: "Buddha Air" },
  { iata: "YT", name: "Yeti Airlines" },
  { iata: "N9", name: "Shree Airlines" },
  { iata: "RA", name: "Nepal Airlines" },
];

const domesticRoutes = [
  { origin_iata: "KTM", destination_iata: "PKR" },
  { origin_iata: "KTM", destination_iata: "BIR" },
  { origin_iata: "KTM", destination_iata: "KEP" },
  { origin_iata: "KTM", destination_iata: "BHR" },
  { origin_iata: "PKR", destination_iata: "JMO" },
];

module.exports = { airports, airlines, domesticRoutes };

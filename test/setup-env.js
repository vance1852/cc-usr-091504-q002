// 在任何被测模块加载前开启测试时钟覆写（X-Now-Ms 请求头）
process.env.ALLOW_CLOCK_OVERRIDE = '1';
process.env.SQLITE_FILE = ':memory:';
